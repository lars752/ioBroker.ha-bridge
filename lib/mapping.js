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
 * Erzeugt die HA MQTT Discovery-Konfiguration für einen Datenpunkt.
 *
 * @param {string} fullId    - vollständige ioBroker-ID, z. B. "shelly-gruppen.0.wohnung_links.Meter1.TotalActivePower"
 * @param {object} common    - ioBroker common-Objekt des Datenpunkts
 * @param {string} discPfx   - HA discovery prefix (z. B. "homeassistant")
 * @param {string} statePfx  - MQTT state topic prefix (z. B. "iob2ha")
 * @returns {{ component: string, uniqueId: string, discTopic: string, stateTopic: string, config: object }|null}
 */
function buildDiscovery(fullId, common, discPfx, statePfx) {
    if (!common) return null;

    // Adapter-Namensraum ermitteln: shelly-gruppen.0 | ecoflow-gruppen.0 | growatt-bms.0
    const parts = fullId.split('.');
    if (parts.length < 3) return null;
    const adapterNs   = `${parts[0]}.${parts[1]}`;   // z. B. "shelly-gruppen.0"
    const adapterName = parts[0];                     // z. B. "shelly-gruppen"

    // deviceKey = erste Ebene unterhalb der Instanz (z. B. "wohnung_links")
    // Hat der Datenpunkt nur eine Ebene darunter (growatt-bms.0.SoC), nimm den Adapter.
    const deviceKey = parts.length >= 4 ? parts[2] : adapterName;
    const deviceId  = `${adapterName}_${deviceKey}`;  // eindeutig über alle Adapter

    // relId = alles ab Ebene 3 (nach deviceKey), z. B. "Meter1.TotalActivePower"
    const relParts  = parts.slice(3);                 // leer wenn nur 3 Teile
    const relId     = relParts.length ? relParts.join('.') : parts[2];

    const uniqueId   = `${deviceId}_${relId.replace(/\./g, '_')}`;
    const stateTopic = `${statePfx}/${adapterName}/${deviceKey}/${relId.replace(/\./g, '/')}`;

    const type  = common.type  || 'string';
    const role  = common.role  || '';
    const unit  = UNIT_MAP[common.unit] || common.unit || undefined;
    const name  = common.name  || relId;

    // binary_sensor für boolesche Werte oder indicator-Rollen
    const isBool = type === 'boolean' || role.startsWith('indicator');
    const component = isBool ? 'binary_sensor' : 'sensor';

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

    // HA-Gerät: je deviceKey ein eigenes Gerät (z. B. "wohnung_links")
    const device = {
        identifiers: [deviceId],
        name:        deviceKey,
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

    const discTopic = `${discPfx}/${component}/${uniqueId}/config`;

    return { component, uniqueId, discTopic, stateTopic, adapterName, deviceKey, config };
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

module.exports = { buildDiscovery, availTopic };
