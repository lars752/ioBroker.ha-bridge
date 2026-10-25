'use strict';

/**
 * ioBroker.ha-bridge
 *
 * Abonniert Datenpunkte aus konfigurierten Quell-Adaptern (shelly-gruppen, ecoflow-gruppen,
 * growatt-bms, …) und überträgt sie per MQTT Discovery zu Home Assistant.
 *
 * Ablauf:
 *   1. MQTT-Verbindung aufbauen.
 *   2. Alle Objekte jeder Quell-Instanz lesen → Discovery-Nachrichten senden.
 *   3. Aktuelle Werte aller Datenpunkte einmalig publishen.
 *   4. Auf Änderungen reagieren (subscribeForeignStates) → publish.
 *   5. Alle publishIntervalSec s alle bekannten Werte erneut senden (Heartbeat).
 */

const utils = require('@iobroker/adapter-core');
const { MqttClient } = require('./lib/mqttclient');
const { buildDiscovery, availTopic, computeUniqueId } = require('./lib/mapping');

class HaBridge extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'ha-bridge' });
        this._mqtt       = null;
        this._discovered = new Map();   // uniqueId → { discTopic, stateTopic, adapterName, config }
        this._topicIndex = new Map();   // stateTopic → disc  (Schnellzugriff für onStateChange)
        this._stateCache = new Map();   // stateTopic → lastValue (als String)
        this._heartbeat  = null;
        this.on('ready',       this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload',      this.onUnload.bind(this));
    }

    // ─── Hilfsmethoden ──────────────────────────────────────────────────────

    _cfg() {
        const c = this.config;
        // groups-Tabelle: [{ enabled, adapter, group }]
        // Daraus ein Map: adapterNs → Set<groupName> (nur enabled; leeres Set = alle)
        const groupMap = {};
        if (Array.isArray(c.groups)) {
            for (const row of c.groups) {
                if (!row || !row.adapter) continue;
                if (!groupMap[row.adapter]) groupMap[row.adapter] = null; // null = Platzhalter (Instanz bekannt)
                if (row.enabled && row.group) {
                    if (groupMap[row.adapter] === null) groupMap[row.adapter] = new Set();
                    groupMap[row.adapter].add(row.group);
                }
            }
        }
        return {
            host:            c.mqttHost          || 'localhost',
            port:            Number(c.mqttPort)  || 1883,
            username:        c.mqttUsername      || '',
            password:        c.mqttPassword      || '',
            useTls:          !!c.mqttUseTls,
            discPfx:         c.discoveryPrefix   || 'homeassistant',
            statePfx:        c.haStateTopic      || 'iob2ha',
            sources:         Array.isArray(c.sources) ? c.sources.filter(s => s.enabled && s.adapter) : [],
            groupMap,        // { [adapterNs]: Set<group>|null }  null = alle Gruppen
            intervalSec:     Math.max(10, Number(c.publishIntervalSec) || 30),
            retainDiscovery: c.retainDiscovery !== false,
        };
    }

    /** Wandelt einen ioBroker-Wert in einen MQTT-Payload-String. */
    _toPayload(val) {
        if (val === null || val === undefined) return '';
        if (typeof val === 'boolean') return val ? 'true' : 'false';
        return String(val);
    }

    /** Sendet Discovery + aktuellen State für einen Datenpunkt. */
    _publishDiscovery(fullId, common, cfg) {
        const disc = buildDiscovery(fullId, common, cfg.discPfx, cfg.statePfx);
        if (!disc) return null;
        const payload = JSON.stringify(disc.config);
        this._mqtt.publish(disc.discTopic, payload, { retain: cfg.retainDiscovery, qos: 1 });
        this._discovered.set(disc.uniqueId, disc);
        this._topicIndex.set(disc.stateTopic, disc);   // Schnellzugriff für onStateChange
        return disc;
    }

    /** Liefert ein Set aller eindeutigen "{adapterName}/{deviceKey}"-Kombinationen. */
    _deviceKeys() {
        const seen = new Set();
        for (const d of this._discovered.values()) {
            seen.add(`${d.adapterName}|${d.deviceKey}`);
        }
        return seen;
    }

    /** Sendet Availability-Online für alle Geräte. */
    _publishAllOnline(cfg) {
        for (const key of this._deviceKeys()) {
            const [a, dk] = key.split('|');
            this._mqtt.publish(availTopic(a, dk, cfg.statePfx), 'online', { retain: true, qos: 1 });
        }
    }

    /** Sendet Availability-Offline für alle Geräte. */
    _publishAllOffline(cfg) {
        for (const key of this._deviceKeys()) {
            const [a, dk] = key.split('|');
            this._mqtt.publish(availTopic(a, dk, cfg.statePfx), 'offline', { retain: true, qos: 1 });
        }
    }

    // ─── Initialisierung ────────────────────────────────────────────────────

    async onReady() {
        await this.setStateAsync('info.connection', false, true);
        const cfg = this._cfg();

        const activeSources = cfg.sources.filter(s => s.enabled && s.adapter);
        if (!activeSources.length) {
            this.log.warn('Keine Quell-Adapter konfiguriert – Adapter bleibt inaktiv');
            return;
        }

        // MQTT aufbauen
        this._mqtt = new MqttClient({
            host:     cfg.host,
            port:     cfg.port,
            username: cfg.username,
            password: cfg.password,
            useTls:   cfg.useTls,
            clientId: `iobroker-ha-bridge-${this.instance}`,
            log:      this.log,
            onConnect:    () => this._onMqttConnect(cfg),
            onDisconnect: () => this.setStateAsync('info.connection', false, true).catch(() => {}),
        });
    }

    async _onMqttConnect(cfg) {
        await this.setStateAsync('info.connection', true, true);

        // Discovery + Initialwerte für alle Quellen
        let total = 0;
        for (const src of cfg.sources) {
            // Gruppen für diese Instanz aus der groups-Tabelle ermitteln.
            // groupMap[adapter] = Set<group> (nur enabled) oder null (alle, da keine Gruppen konfiguriert).
            // Wenn die Instanz gar nicht in groupMap auftaucht, werden alle Gruppen übertragen (Rückwärtskompatibilität).
            const allowedGroups = cfg.groupMap.hasOwnProperty(src.adapter)
                ? (cfg.groupMap[src.adapter] || new Set())  // null → leeres Set → alle
                : new Set();                                  // nicht konfiguriert → alle
            total += await this._initSource(src.adapter, allowedGroups, cfg);
        }
        this.log.info(`Discovery abgeschlossen: ${total} Datenpunkte an HA gemeldet`);
        this._publishAllOnline(cfg);

        // Abonnements
        for (const src of cfg.sources) {
            this.subscribeForeignStates(`${src.adapter}.*`);
        }

        // Heartbeat: alle N Sekunden alle bekannten Werte erneut senden
        this._heartbeat = setInterval(() => this._sendHeartbeat(cfg), cfg.intervalSec * 1000);
    }

    /** Liest alle Objekte + Zustände einer Quell-Instanz und sendet Discovery + Initialwerte. */
    async _initSource(adapterNs, groups, cfg) {
        let count = 0;
        let objs;
        try {
            objs = await this.getForeignObjectsAsync(`${adapterNs}.*`, 'state');
        } catch (e) {
            this.log.error(`Objekte von ${adapterNs} nicht lesbar: ${e.message}`);
            return 0;
        }

        for (const [fullId, obj] of Object.entries(objs || {})) {
            if (!obj || obj.type !== 'state') continue;
            const common = obj.common;
            if (!common) continue;

            // info.connection des Quell-Adapters nicht einzeln weiterleiten
            if (fullId.endsWith('.info.connection')) continue;

            // Gruppen-Filter: deviceKey = parts[2]
            if (groups.size > 0) {
                const parts = fullId.split('.');
                const deviceKey = parts.length >= 4 ? parts[2] : null;
                if (!deviceKey || !groups.has(deviceKey)) continue;
            }

            const disc = this._publishDiscovery(fullId, common, cfg);
            if (!disc) continue;

            // Initialwert
            try {
                const state = await this.getForeignStateAsync(fullId);
                if (state && state.val !== null && state.val !== undefined) {
                    const payload = this._toPayload(state.val);
                    this._mqtt.publish(disc.stateTopic, payload, { retain: false });
                    this._stateCache.set(disc.stateTopic, payload);
                }
            } catch (_) { /* ignorieren */ }
            count++;
        }
        const groupHint = groups.size ? ` (Gruppen: ${[...groups].join(', ')})` : '';
        this.log.info(`${adapterNs}${groupHint}: ${count} Datenpunkte → Discovery gesendet`);
        return count;
    }

    /** Wird bei jeder Zustandsänderung in einem Quell-Adapter aufgerufen. */
    onStateChange(id, state) {
        if (!this._mqtt || !this._mqtt.connected) return;
        if (!state) return;

        // stateTopic aus der ioBroker-ID rekonstruieren und damit disc-Eintrag finden.
        // Das stateTopic wird in buildDiscovery ohne Bereinigung gebaut, daher passt
        // die direkte Rekonstruktion immer – auch bei Seriennummern im Pfad.
        const parts    = id.split('.');
        if (parts.length < 3) return;
        const adapterName = parts[0];
        const deviceKey   = parts.length >= 4 ? parts[2] : adapterName;
        const relId       = parts.slice(3).length ? parts.slice(3).join('/') : parts[2];
        const cfg         = this._cfg();
        const topicKey    = `${cfg.statePfx}/${adapterName}/${deviceKey}/${relId}`;
        const disc = this._topicIndex.get(topicKey);
        if (!disc) return;   // nicht registriert (z. B. durch einen Neustart entdeckt)

        const payload = this._toPayload(state.val);
        if (this._stateCache.get(disc.stateTopic) === payload) return;   // kein Update nötig
        this._stateCache.set(disc.stateTopic, payload);
        this._mqtt.publish(disc.stateTopic, payload, { retain: false });
    }

    /** Sendet alle gecachten Werte erneut (Heartbeat für HA). */
    _sendHeartbeat(cfg) {
        if (!this._mqtt || !this._mqtt.connected) return;
        let n = 0;
        for (const [topic, payload] of this._stateCache) {
            this._mqtt.publish(topic, payload, { retain: false });
            n++;
        }
        this._publishAllOnline(cfg);
        this.log.debug(`Heartbeat: ${n} Werte erneut gesendet`);
    }

    // ─── Unload ─────────────────────────────────────────────────────────────

    onUnload(callback) {
        try {
            if (this._heartbeat) clearInterval(this._heartbeat);
            if (this._mqtt) {
                const cfg = this._cfg();
                this._publishAllOffline(cfg);
                this._mqtt.end();
            }
            this.setState('info.connection', false, true);
        } finally {
            callback();
        }
    }

    /**
     * Admin-Nachrichten.
     *
     * discoverGroups: Liest alle aktiven Quell-Instanzen aus der gesendeten Konfiguration,
     *                 ermittelt deren Gruppen und gibt eine aktualisierte groups-Tabelle zurück.
     *                 Bestehende enabled-Flags werden beibehalten; neue Gruppen werden mit
     *                 enabled=true ergänzt.
     *
     * listGroups: (Legacy) liest Gruppen einer einzelnen Instanz, gibt [{label, value}] zurück.
     */
    async onMessage(obj) {
        if (!obj || !obj.callback) return;

        if (obj.command === 'discoverGroups') {
            const cfg = (obj.message && obj.message.config) || {};
            const sources = Array.isArray(cfg.sources) ? cfg.sources.filter(s => s.enabled && s.adapter) : [];
            const existingGroups = Array.isArray(cfg.groups) ? cfg.groups : [];

            // Bestehende Gruppen in eine Map überführen: "adapter|group" → row
            const existingMap = new Map();
            for (const row of existingGroups) {
                if (row && row.adapter && row.group) {
                    existingMap.set(`${row.adapter}|${row.group}`, row);
                }
            }

            const newRows = [];
            for (const src of sources) {
                let discoveredGroups = new Set();
                try {
                    const objs = await this.getForeignObjectsAsync(`${src.adapter}.*`, 'state');
                    for (const fullId of Object.keys(objs || {})) {
                        const parts = fullId.split('.');
                        if (parts.length >= 4) discoveredGroups.add(parts[2]);
                    }
                } catch (e) {
                    this.log.warn(`discoverGroups für ${src.adapter}: ${e.message}`);
                }

                for (const group of [...discoveredGroups].sort()) {
                    const key = `${src.adapter}|${group}`;
                    const existing = existingMap.get(key);
                    newRows.push({
                        enabled: existing ? existing.enabled : true,
                        adapter: src.adapter,
                        group,
                    });
                    existingMap.delete(key); // bereits verarbeitet
                }
            }

            // Zeilen für inzwischen nicht mehr gefundene Gruppen entfernen (nicht in newRows übernehmen)
            // → bewusste Entscheidung: veraltete Einträge werden beim Einlesen entfernt

            this.log.info(`discoverGroups: ${newRows.length} Gruppen aus ${sources.length} Instanzen ermittelt`);
            // useNative=true: ioBroker Admin merged { native: {...} } direkt in die Konfiguration
            this.sendTo(obj.from, obj.command, { native: { groups: newRows } }, obj.callback);
            return;
        }

        if (obj.command === 'listGroups') {
            const adapterNs = obj.message && obj.message.adapter;
            if (!adapterNs) {
                this.sendTo(obj.from, obj.command, [{ label: '(keine Instanz angegeben)', value: '' }], obj.callback);
                return;
            }
            try {
                const objs = await this.getForeignObjectsAsync(`${adapterNs}.*`, 'state');
                const groups = new Set();
                for (const fullId of Object.keys(objs || {})) {
                    const parts = fullId.split('.');
                    if (parts.length >= 4) groups.add(parts[2]);
                }
                const options = groups.size
                    ? [...groups].sort().map(g => ({ label: g, value: g }))
                    : [{ label: '(keine Gruppen gefunden)', value: '' }];
                this.sendTo(obj.from, obj.command, options, obj.callback);
            } catch (e) {
                this.log.error(`listGroups für ${adapterNs}: ${e.message}`);
                this.sendTo(obj.from, obj.command, [{ label: `Fehler: ${e.message}`, value: '' }], obj.callback);
            }
        }
    }
}

if (require.main !== module) module.exports = (options) => new HaBridge(options);
else new HaBridge();
