'use strict';

/**
 * Mapping: ioBroker-Datenpunkt → Home Assistant MQTT-Discovery-Konfiguration
 *
 * Für jeden abonnierten Datenpunkt wird aus dem ioBroker-common-Objekt eine
 * HA-Discovery-Nachricht gebaut.
 *
 * HA-Geräte werden nach der **ersten Ebene unterhalb der Instanz** gruppiert,
 * d. h. bei "shelly-gruppen.0.wohnung_links.Meter1.Power" ist das Gerät
 * "wohnung_links" (nicht der ganze Adapter).
 *
 * Hat ein Adapter nur 2 Ebenen ("growatt-bms.0.SoC"), wird der Adapter-Name
 * als Gerät verwendet.
 *
 * Naming-Konvention für die MQTT-Topics:
 *   discovery:  <prefix>/sensor/<unique_id>/config
 *   state:      <stateTopic>/<adapterName>/<deviceKey>/<relId>
 *
 * unique_id    = <adapterName>_<deviceKey>_<relId> (Punkte → Unterstriche)
 * availability = <stateTopic>/<adapterName>/<deviceKey>/availability
 */

// ioBroker role → HA device_class (Auswahl der häufigsten)
const ROLE_TO_CLASS = {
    'value.power':       'power',
    'value.voltage':     'voltage',
    'value.current':     'current',
    'value.temperature': 'temperature',
    'value.battery':     'battery',
    'value.energy':      'energy',
    'value.time':        'timestamp',
    'indicator.reachable': null,    // → binary_sensor
    'indicator.alarm':     null,    // → binary_sensor
    'indicator.connected': null,    // → binary_sensor
};

// ioBroker unit → HA unit_of_measurement
const UNIT_MAP = {
    'W':   'W',
    'kW':  'kW',
    'Wh':  'Wh',
    'kWh': 'kWh',
    'V':   'V',
    'A':   'A',
    '%':   '%',
    '°C':  '°C',
    'Ah':  'Ah',
    'mV':  'mV',
};

/**
 * Entfernt Geräte-IDs (Seriennummern) aus einem Pfadsegment.
 * Beispiel: "WR1_HW51ZOH4SF6L7948" → "WR1"
 * Regel: Ein Segment das nach "_" oder am Anfang einen Block aus ≥8 Großbuchstaben+Ziffern hat,
 *        wird auf den Teil vor dem ersten solchen Block gekürzt.
 */
function stripDeviceId(segment) {
    // Seriennummer = 8+ Zeichen nur aus A-Z0-9, nach einem Unterstrich oder am Anfang
    return segment.replace(/_[A-Z0-9]{8,}/g, '').replace(/^[A-Z0-9]{8,}$/g, segment) || segment;
}

/**
 * Bereinigt alle Segmente eines Pfads (Punkte als Trenner).
 */
function cleanPath(path) {
    return path.split('.').map(stripDeviceId).join('.');
}

/**
 * Bereinigt einen common.name von Seriennummern und technischen Suffixen.
 * Beispiele:
 *   "WR1 (HW51ZOH4SF764101) - Ausgangsleistung (invOutputWatts)" → "Ausgangsleistung"
 *   "WR1 - Ausgangsleistung"                                      → "Ausgangsleistung"
 *   "Ausgangsleistung"                                             → "Ausgangsleistung"
 *   "Gesamt-Ausgangsleistung akku_wohnung_links"                  → "Gesamt-Ausgangsleistung"
 */
function cleanName(name) {
    if (!name) return name;
    let n = String(name);
    // Seriennummer in Klammern entfernen: "(HW51ZOH4SF764101)"
    n = n.replace(/\s*\([A-Z0-9]{8,}\)\s*/g, ' ');
    // Technischen Zustandsnamen in Klammern am Ende entfernen: "(invOutputWatts)"
    n = n.replace(/\s*\([a-zA-Z][a-zA-Z0-9]*\)\s*$/, '');
    // WRx-Präfix NICHT entfernen – er ist das einzige Unterscheidungsmerkmal
    // zwischen mehreren Wechselrichtern derselben Gruppe.
    // Gruppen-Suffix (Unterstrich-Bezeichner am Ende) entfernen: "akku_wohnung_links"
    n = n.replace(/\s+[a-z][a-z0-9]*(?:_[a-z0-9]+)+\s*$/, '');
    return n.trim();
}

/**
 * Erzeugt die HA MQTT Discovery-Konfiguration für einen Datenpunkt.
 *
 * @param {string} fullId    - vollständige ioBroker-ID, z. B. "shelly-gruppen.0.wohnung_links.Meter1.TotalActivePower"
 * @param {object} common    - ioBroker common-Objekt des Datenpunkts
 * @param {string} discPfx   - HA discovery prefix (z. B. "homeassistant")
 * @param {string} statePfx  - MQTT state topic prefix (z. B. "iob2ha")
 * @param {object} [opts]   - { control: bool, sibling: { id, common } } – Steuerung HA → ioBroker (Schalter, Licht, Zahl)
 * @returns {{ component: string, uniqueId: string, discTopic: string, stateTopic: string, config: object, commands: object[], removeTopics: string[] }|null}
 */
function buildDiscovery(fullId, common, discPfx, statePfx, opts = {}) {
    if (!common) return null;

    // Adapter-Namensraum ermitteln: shelly-gruppen.0 | ecoflow-gruppen.0 | growatt-bms.0
    const parts = fullId.split('.');
    if (parts.length < 3) return null;
    const adapterNs   = `${parts[0]}.${parts[1]}`;   // z. B. "shelly-gruppen.0"
    const adapterName = parts[0];                     // z. B. "shelly-gruppen"

    // deviceKey = erste Ebene unterhalb der Instanz (z. B. "wohnung_links" oder "WR1_HW51ZOH4SF6L7948")
    // Hat der Datenpunkt nur eine Ebene darunter (growatt-bms.0.SoC), nimm den Adapter.
    const deviceKey = parts.length >= 4 ? parts[2] : adapterName;
    const deviceId  = `${adapterName}_${deviceKey}`;  // eindeutig über alle Adapter (mit voller Serial für Stabilität)

    // relId = alles ab Ebene 3 (nach deviceKey), z. B. "WR1_HW51ZOH4SF6L7948.invOutputWatts"
    const relParts  = parts.slice(3);                 // leer wenn nur 3 Teile
    const relId     = relParts.length ? relParts.join('.') : parts[2];

    // Bereinigte Varianten für HA-Anzeigenamen (ohne Seriennummern)
    const deviceKeyClean = stripDeviceId(deviceKey);  // "wohnung_links" bleibt, "WR1_HW51ZOH4SF6L7948" → "WR1"
    const relIdClean     = cleanPath(relId);           // "WR1_HW51ZOH4SF6L7948.invOutputWatts" → "WR1.invOutputWatts"

    const type  = common.type  || 'string';
    const role  = common.role  || '';
    const unit  = UNIT_MAP[common.unit] || common.unit || undefined;
    const name  = cleanName(common.name || relIdClean);

    // uniqueId: <adapterName>_<deviceKeyClean>_<zwischenSegmente bereinigt>_<nameSlug>
    // Beispiel: ecoflow-gruppen.0.wohnung_links.WR1_HW51.invOutputWatts
    //   → ecoflow_gruppen_wohnung_links_WR1_ausgangsleistung
    // Das letzte relId-Segment (technischer Zustandsname) wird durch common.name ersetzt.
    // Zwischenebenen (z. B. WR1 aus WR1_HW51) bleiben bereinigt erhalten.
    let nameSlug       = name.toLowerCase().replace(/[^a-z0-9äöü]+/g, '_').replace(/^_|_$/g, '');
    // Zwischensegmente = alle relId-Teile außer dem letzten (dem Zustandsnamen)
    const relSegments  = relIdClean.split('.');
    const midSegments  = relSegments.length > 1 ? relSegments.slice(0, -1) : [];
    // Wenn nameSlug mit einem der vorherigen Segmente beginnt, diesen Präfix abschneiden
    // (z. B. name="Meter1 TotalActivePower", midSeg="Meter1" → slug wird "totalactivepower")
    for (const seg of [...midSegments, deviceKeyClean]) {
        const segSlug = seg.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        if (nameSlug.startsWith(segSlug + '_')) {
            nameSlug = nameSlug.slice(segSlug.length + 1);
            break;
        }
    }
    // Doppelte aufeinanderfolgende Teile entfernen (z. B. wenn deviceKey = adapterName bei flacher Struktur)
    const rawParts     = [adapterName, deviceKeyClean, ...midSegments, nameSlug].filter(Boolean);
    const dedupParts   = rawParts.filter((p, i) => i === 0 || p.toLowerCase() !== rawParts[i - 1].toLowerCase());
    const uniqueId     = dedupParts.join('_');
    const stateTopic   = `${statePfx}/${adapterName}/${deviceKey}/${relId.replace(/\./g, '/')}`;

    // binary_sensor für boolesche Werte oder indicator-Rollen
    const isBool = type === 'boolean' || role.startsWith('indicator');
    let component = isBool ? 'binary_sensor' : 'sensor';

    // Steuerung HA → ioBroker (nur wenn für die Quelle aktiviert und der Datenpunkt beschreibbar ist)
    const control = !!opts.control && common.write === true;
    const sibling = control && type === 'boolean' && opts.sibling && opts.sibling.common ? opts.sibling : null;
    if (control && type === 'boolean' && !role.startsWith('indicator') && !/^(button|sensor|value)/.test(role)) {
        component = sibling || role.startsWith('switch.light') ? 'light' : 'switch';
    } else if (control && type === 'number' && Number.isFinite(common.min) && Number.isFinite(common.max)) {
        component = 'number';
    }

    // device_class aus Role ableiten
    let deviceClass = ROLE_TO_CLASS[role];
    if (deviceClass === undefined && unit === 'W')    deviceClass = 'power';
    if (deviceClass === undefined && unit === 'V')    deviceClass = 'voltage';
    if (deviceClass === undefined && unit === 'A')    deviceClass = 'current';
    if (deviceClass === undefined && unit === '%')    deviceClass = 'battery';
    if (deviceClass === undefined && unit === '°C')   deviceClass = 'temperature';
    if (deviceClass === undefined && unit === 'kWh')  deviceClass = 'energy';
    // null explizit gesetzt = kein device_class

    // state_class: "measurement" für Leistung/Strom/Spannung, "total_increasing" für Energie
    let stateClass;
    if (component === 'sensor') {
        if (deviceClass === 'energy') stateClass = 'total_increasing';
        else if (['power','voltage','current','battery','temperature'].includes(deviceClass)) stateClass = 'measurement';
    }

    // HA-Gerät: je deviceKey ein eigenes Gerät (z. B. "wohnung_links" oder "WR1")
    const device = {
        identifiers: [deviceId],
        name:        deviceKeyClean,   // bereinigt: ohne Seriennummer
        model:       adapterName,
        manufacturer: 'ioBroker',
        via_device:  adapterNs.replace(/\./g, '_'),   // logische Eltern-Verknüpfung
    };

    const config = {
        name,
        unique_id:   uniqueId,
        state_topic: stateTopic,
        device,
        availability_topic: `${statePfx}/${adapterName}/${deviceKey}/availability`,
    };
    if (deviceClass)  config.device_class        = deviceClass;
    if (stateClass)   config.state_class          = stateClass;
    if (unit)         config.unit_of_measurement  = unit;
    if (isBool) {
        config.payload_on  = 'true';
        config.payload_off = 'false';
    }

    const commands = [];
    if (component === 'switch' || component === 'light') {
        config.command_topic = `${stateTopic}/set`;
        commands.push({ topic: config.command_topic, id: fullId, type: 'boolean' });
        if (component === 'light' && sibling) {
            const bTopic = stateTopicOf(sibling.id, statePfx);
            const bMax = Number.isFinite(sibling.common.max) && sibling.common.max > 0 ? sibling.common.max : 100;
            config.brightness_state_topic   = bTopic;
            config.brightness_command_topic = `${bTopic}/set`;
            config.brightness_scale         = bMax;
            commands.push({ topic: config.brightness_command_topic, id: sibling.id, type: 'number', min: 0, max: bMax });
        }
        delete config.device_class;
    } else if (component === 'number') {
        config.command_topic = `${stateTopic}/set`;
        config.min  = common.min;
        config.max  = common.max;
        config.step = Number.isFinite(common.step) && common.step > 0 ? common.step : 1;
        config.mode = 'box';
        commands.push({ topic: config.command_topic, id: fullId, type: 'number', min: common.min, max: common.max });
        delete config.state_class;
        delete config.device_class;
    }

    const discTopic = `${discPfx}/${component}/${uniqueId}/config`;
    // Alte Discovery-Einträge desselben Datenpunkts als anderer Typ (z. B. früher binary_sensor) entfernen
    const alternatives = type === 'boolean' || role.startsWith('indicator') ? ['binary_sensor', 'switch', 'light'] : ['sensor', 'number'];
    const removeTopics = alternatives.filter(c => c !== component).map(c => `${discPfx}/${c}/${uniqueId}/config`);

    return { component, uniqueId, discTopic, stateTopic, adapterName, deviceKey, config, commands, removeTopics };
}

/** State-Topic zu einer ioBroker-ID (wie in buildDiscovery). */
function stateTopicOf(fullId, statePfx) {
    const parts       = fullId.split('.');
    const adapterName = parts[0];
    const deviceKey   = parts.length >= 4 ? parts[2] : adapterName;
    const relId       = parts.slice(3).length ? parts.slice(3).join('.') : parts[2];
    return `${statePfx}/${adapterName}/${deviceKey}/${relId.replace(/\./g, '/')}`;
}

/** Helligkeits-Datenpunkt (beschreibbare Zahl, Rolle level.brightness/level.dimmer oder Name brightness/level/dimmer). */
function isBrightness(fullId, common) {
    if (!common || common.type !== 'number' || common.write !== true) return false;
    const role = String(common.role || '');
    const last = fullId.split('.').pop().toLowerCase();
    return /^level\.(brightness|dimmer)$/.test(role) || ['brightness', 'level', 'dimmer'].includes(last);
}

/** Befehlswert aus dem MQTT-Payload; null = ungültig. */
function parseCommand(payload, spec) {
    const p = String(payload === null || payload === undefined ? '' : payload).trim();
    if (spec.type === 'boolean') {
        const l = p.toLowerCase();
        if (['true', 'on', '1'].includes(l)) return true;
        if (['false', 'off', '0'].includes(l)) return false;
        return null;
    }
    if (p === '') return null;
    const n = Number(p);
    if (!Number.isFinite(n)) return null;
    let v = n;
    if (Number.isFinite(spec.min)) v = Math.max(spec.min, v);
    if (Number.isFinite(spec.max)) v = Math.min(spec.max, v);
    return v;
}

/**
 * Gibt den availability-Topic-Pfad für ein Gerät zurück.
 * @param {string} adapterName  - z. B. "shelly-gruppen"
 * @param {string} deviceKey    - z. B. "wohnung_links"  (= adapterName wenn flach)
 * @param {string} statePfx     - z. B. "iob2ha"
 */
function availTopic(adapterName, deviceKey, statePfx) {
    return `${statePfx}/${adapterName}/${deviceKey}/availability`;
}

/**
 * Berechnet nur die uniqueId für eine ioBroker-ID + common.name.
 * Wird in main.js für onStateChange verwendet, um den Map-Key ohne
 * das vollständige buildDiscovery aufrufen zu müssen.
 */
function computeUniqueId(fullId, name) {
    const parts        = fullId.split('.');
    if (parts.length < 3) return null;
    const adapterName  = parts[0];
    const deviceKey    = parts.length >= 4 ? parts[2] : adapterName;
    const relParts     = parts.slice(3);
    const relId        = relParts.length ? relParts.join('.') : parts[2];
    const deviceKeyClean = stripDeviceId(deviceKey);
    const relIdClean     = cleanPath(relId);
    const relSegments  = relIdClean.split('.');
    const midSegments  = relSegments.length > 1 ? relSegments.slice(0, -1) : [];
    let nameSlug       = name.toLowerCase().replace(/[^a-z0-9äöü]+/g, '_').replace(/^_|_$/g, '');
    for (const seg of [...midSegments, deviceKeyClean]) {
        const segSlug = seg.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        if (nameSlug.startsWith(segSlug + '_')) { nameSlug = nameSlug.slice(segSlug.length + 1); break; }
    }
    const rawParts   = [adapterName, deviceKeyClean, ...midSegments, nameSlug].filter(Boolean);
    const dedupParts = rawParts.filter((p, i) => i === 0 || p.toLowerCase() !== rawParts[i - 1].toLowerCase());
    return dedupParts.join('_');
}

module.exports = { buildDiscovery, stateTopicOf, isBrightness, parseCommand, availTopic, stripDeviceId, cleanPath, cleanName, computeUniqueId };
