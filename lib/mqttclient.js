'use strict';

/**
 * Dünne Kapselung von mqtt.js für den HA-Bridge-Adapter.
 *
 * - Verbindet mit dem konfigurierten Broker
 * - Veröffentlicht Discovery- und State-Nachrichten
 * - Meldet Online/Offline über onConnect / onDisconnect Callbacks
 */

const mqtt = require('mqtt');

class MqttClient {
    /**
     * @param {object} opts
     * @param {string}  opts.host
     * @param {number}  opts.port
     * @param {string}  opts.username
     * @param {string}  opts.password
     * @param {boolean} opts.useTls
     * @param {string}  opts.clientId
     * @param {object}  opts.log          – { info, warn, error, debug }
     * @param {Function} opts.onConnect
     * @param {Function} opts.onDisconnect
     */
    constructor(opts) {
        this._log  = opts.log;
        this._onConnect    = opts.onConnect    || (() => {});
        this._onDisconnect = opts.onDisconnect || (() => {});
        this._client = null;

        const proto = opts.useTls ? 'mqtts' : 'mqtt';
        const url   = `${proto}://${opts.host}:${opts.port}`;

        const mqttOpts = {
            clientId:    opts.clientId || `iobroker-ha-bridge-${Math.random().toString(16).slice(2, 8)}`,
            clean:       true,
            reconnectPeriod: 5000,
            connectTimeout:  10000,
        };
        if (opts.username) mqttOpts.username = opts.username;
        if (opts.password) mqttOpts.password = opts.password;

        this._log.info(`MQTT: verbinde mit ${url}`);
        this._client = mqtt.connect(url, mqttOpts);

        this._client.on('connect', () => {
            this._log.info('MQTT: verbunden');
            this._onConnect();
        });
        this._client.on('reconnect', () => this._log.info('MQTT: verbinde erneut…'));
        this._client.on('close',     () => { this._log.warn('MQTT: getrennt'); this._onDisconnect(); });
        this._client.on('error',     (e) => this._log.error(`MQTT-Fehler: ${e.message}`));
    }

    /**
     * Veröffentlicht eine Nachricht (fire-and-forget; Fehler werden geloggt).
     * @param {string}  topic
     * @param {string|Buffer} payload
     * @param {object}  [opts]   – retain, qos
     */
    publish(topic, payload, opts = {}) {
        if (!this._client || !this._client.connected) return;
        this._client.publish(topic, payload, { retain: opts.retain || false, qos: opts.qos || 0 }, (err) => {
            if (err) this._log.error(`MQTT publish ${topic}: ${err.message}`);
        });
    }

    /**
     * Schließt die Verbindung sauber.
     */
    end() {
        if (this._client) {
            this._client.end(true);
            this._client = null;
        }
    }

    get connected() {
        return !!(this._client && this._client.connected);
    }
}

module.exports = { MqttClient };
