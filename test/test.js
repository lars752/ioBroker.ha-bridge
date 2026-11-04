'use strict';

/**
 * Unit-Tests für lib/mapping.js – ohne ioBroker und ohne MQTT.
 */

const assert  = require('assert');
const { buildDiscovery, availTopic, parseCommand, isBrightness, stateTopicOf } = require('../lib/mapping');

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); console.log(`  ✓  ${name}`); passed++; }
    catch (e) { console.error(`  ✗  ${name}\n     ${e.message}`); failed++; }
}

// ── buildDiscovery ────────────────────────────────────────────────────────

console.log('\nbuildDiscovery – Shelly Power');
const shellyPower = buildDiscovery(
    'shelly-gruppen.0.wohnung_links.Meter1.TotalActivePower',
    { name: 'Meter1 TotalActivePower', type: 'number', role: 'value.power', unit: 'W', read: true },
    'homeassistant', 'iob2ha'
);
test('gibt Objekt zurück',              () => assert(shellyPower !== null));
test('component = sensor',              () => assert.strictEqual(shellyPower.component, 'sensor'));
test('device_class = power',            () => assert.strictEqual(shellyPower.config.device_class, 'power'));
test('unit_of_measurement = W',         () => assert.strictEqual(shellyPower.config.unit_of_measurement, 'W'));
test('state_class = measurement',       () => assert.strictEqual(shellyPower.config.state_class, 'measurement'));
test('stateTopic enthält Adapter',      () => assert(shellyPower.stateTopic.includes('shelly-gruppen')));
test('discTopic beginnt mit prefix',    () => assert(shellyPower.discTopic.startsWith('homeassistant/sensor/')));
test('uniqueId enthält common.name',    () => assert(shellyPower.uniqueId.includes('meter1_totalactivepower') || shellyPower.uniqueId.includes('Meter1_TotalActivePower') || shellyPower.uniqueId.toLowerCase().includes('meter1')));
test('device.model = shelly-gruppen',   () => assert.strictEqual(shellyPower.config.device.model, 'shelly-gruppen'));

console.log('\nbuildDiscovery – Boolean (Online)');
const onlineDisc = buildDiscovery(
    'growatt-bms.0.Online',
    { name: 'BMS Online Status', type: 'boolean', role: 'indicator.reachable', read: true },
    'homeassistant', 'iob2ha'
);
test('component = binary_sensor',       () => assert.strictEqual(onlineDisc.component, 'binary_sensor'));
test('payload_on = "true"',             () => assert.strictEqual(onlineDisc.config.payload_on, 'true'));

console.log('\nbuildDiscovery – Ecoflow Energie');
const ecoDisc = buildDiscovery(
    'ecoflow-gruppen.0.PV.WR1.InvOutputWatts',
    { name: 'WR1 Ausgangsleistung', type: 'number', role: 'value.power', unit: 'W', read: true },
    'homeassistant', 'iob2ha'
);
test('adapterName = ecoflow-gruppen',   () => assert.strictEqual(ecoDisc.adapterName, 'ecoflow-gruppen'));
test('stateTopic enthält PV/WR1',       () => assert(ecoDisc.stateTopic.includes('PV/WR1')));

console.log('\nbuildDiscovery – Ecoflow mit Seriennummer im deviceKey');
const ecoSerial = buildDiscovery(
    'ecoflow-gruppen.0.WR1_HW51ZOH4SF6L7948.invOutputWatts',
    { name: 'Ausgangsleistung', type: 'number', role: 'value.power', unit: 'W', read: true },
    'homeassistant', 'iob2ha'
);
test('gibt Objekt zurück',              () => assert(ecoSerial !== null));
test('deviceKey enthält Serial (intern)',() => assert.strictEqual(ecoSerial.deviceKey, 'WR1_HW51ZOH4SF6L7948'));
test('device.name ohne Serial',         () => assert.strictEqual(ecoSerial.config.device.name, 'WR1'));
test('uniqueId ohne Serial',            () => assert(!ecoSerial.uniqueId.includes('HW51ZOH4SF6L7948')));
test('stateTopic mit Serial (Routing)', () => assert(ecoSerial.stateTopic.includes('WR1_HW51ZOH4SF6L7948')));
test('name aus common.name',            () => assert.strictEqual(ecoSerial.config.name, 'Ausgangsleistung'));

console.log('\nbuildDiscovery – Ecoflow mit WRx-Präfix im common.name');
const ecoWrName = buildDiscovery(
    'ecoflow-gruppen.0.akku_wohnung_links.WR1_HW51ZOH4SF764101.invOutputWatts',
    { name: 'WR1 (HW51ZOH4SF764101) - Ausgangsleistung (invOutputWatts)', type: 'number', role: 'value.power', unit: 'W', read: true },
    'homeassistant', 'iob2ha'
);
test('WRx bleibt im Namen erhalten',    () => assert(ecoWrName.config.name.startsWith('WR1')));
test('Serial wird aus Namen entfernt',  () => assert(!ecoWrName.config.name.includes('HW51ZOH4SF764101')));
test('technisches Suffix entfernt',     () => assert(!ecoWrName.config.name.includes('invOutputWatts')));
test('uniqueId ohne Serial',            () => assert(!ecoWrName.uniqueId.includes('hw51zoh4sf764101')));

console.log('\nbuildDiscovery – info.connection wird ignoriert');
test('fullId zu kurz → null',           () => assert.strictEqual(buildDiscovery('shelly-gruppen.0', {}, 'ha', 'iob'), null));

console.log('\nbuildDiscovery – deviceKey');
test('deviceKey = wohnung_links',       () => assert.strictEqual(shellyPower.deviceKey, 'wohnung_links'));
test('device.name = wohnung_links',     () => assert.strictEqual(shellyPower.config.device.name, 'wohnung_links'));
test('stateTopic enthält deviceKey',    () => assert(shellyPower.stateTopic.includes('wohnung_links')));
test('availTopic enthält deviceKey',    () => assert(shellyPower.config.availability_topic.includes('wohnung_links')));

console.log('\nbuildDiscovery – flache Struktur (growatt-bms.0.SoC)');
const flatDisc = buildDiscovery(
    'growatt-bms.0.SoC',
    { name: 'SoC', type: 'number', role: 'value.battery', unit: '%', read: true },
    'homeassistant', 'iob2ha'
);
test('gibt Objekt zurück',              () => assert(flatDisc !== null));
test('deviceKey = adapterName (flach)', () => assert.strictEqual(flatDisc.deviceKey, 'growatt-bms'));

console.log('\navailTopic');
test('Availability Topic mit deviceKey', () => assert.strictEqual(availTopic('shelly-gruppen', 'wohnung_links', 'iob2ha'), 'iob2ha/shelly-gruppen/wohnung_links/availability'));

console.log('\nSteuerung HA → ioBroker (licht-gruppen)');
const grpOn = { name: 'Gruppe Esszimmer an/aus', type: 'boolean', role: 'switch.light', read: true, write: true };
const grpBri = { name: 'Helligkeit Esszimmer', type: 'number', unit: '%', min: 0, max: 100, role: 'level.brightness', read: true, write: true };
const lightDisc = buildDiscovery('licht-gruppen.0.Esszimmer.on', grpOn, 'homeassistant', 'iob2ha', { control: true, sibling: { id: 'licht-gruppen.0.Esszimmer.brightness', common: grpBri } });
test('mit Steuerung und Helligkeit: light',        () => assert.strictEqual(lightDisc.component, 'light'));
test('command_topic = <state>/set',                 () => assert.strictEqual(lightDisc.config.command_topic, 'iob2ha/licht-gruppen/Esszimmer/on/set'));
test('Helligkeit: state/command/scale',             () => { assert.strictEqual(lightDisc.config.brightness_state_topic, 'iob2ha/licht-gruppen/Esszimmer/brightness'); assert.strictEqual(lightDisc.config.brightness_command_topic, 'iob2ha/licht-gruppen/Esszimmer/brightness/set'); assert.strictEqual(lightDisc.config.brightness_scale, 100); });
test('commands: an/aus und Helligkeit',            () => assert.deepStrictEqual(lightDisc.commands.map(c => [c.topic.split('/').slice(-2, -1)[0], c.id.split('.').pop(), c.type]), [['on', 'on', 'boolean'], ['brightness', 'brightness', 'number']]));
test('alte Discovery-Einträge werden entfernt',     () => assert.deepStrictEqual(lightDisc.removeTopics, ['homeassistant/binary_sensor/' + lightDisc.uniqueId + '/config', 'homeassistant/switch/' + lightDisc.uniqueId + '/config']));
const plainOn = buildDiscovery('licht-gruppen.0.Esszimmer.on', grpOn, 'homeassistant', 'iob2ha');
test('ohne Steuerung bleibt binary_sensor',          () => { assert.strictEqual(plainOn.component, 'binary_sensor'); assert.strictEqual(plainOn.commands.length, 0); assert.strictEqual(plainOn.config.command_topic, undefined); });
const sw = buildDiscovery('x.0.dev.relay', { name: 'Relais', type: 'boolean', role: 'switch', write: true }, 'homeassistant', 'iob2ha', { control: true });
test('beschreibbarer Schalter: switch',             () => assert.strictEqual(sw.component, 'switch'));
const ro = buildDiscovery('x.0.dev.state', { name: 'Zustand', type: 'boolean', role: 'sensor.state', write: false }, 'homeassistant', 'iob2ha', { control: true });
test('nicht beschreibbar bleibt binary_sensor',     () => assert.strictEqual(ro.component, 'binary_sensor'));
const ind = buildDiscovery('x.0.dev.alarm', { name: 'Alarm', type: 'boolean', role: 'indicator.alarm', write: true }, 'homeassistant', 'iob2ha', { control: true });
test('indicator bleibt binary_sensor',              () => assert.strictEqual(ind.component, 'binary_sensor'));
const num = buildDiscovery('x.0.dev.limit', { name: 'Limit', type: 'number', role: 'level', unit: 'W', min: 0, max: 800, write: true }, 'homeassistant', 'iob2ha', { control: true });
test('Zahl mit min/max: number',                    () => { assert.strictEqual(num.component, 'number'); assert.strictEqual(num.config.max, 800); assert.strictEqual(num.config.command_topic, 'iob2ha/x/dev/limit/set'); });
const num2 = buildDiscovery('x.0.dev.val', { name: 'Wert', type: 'number', role: 'level', write: true }, 'homeassistant', 'iob2ha', { control: true });
test('Zahl ohne min/max bleibt sensor',             () => assert.strictEqual(num2.component, 'sensor'));
test('parseCommand boolean',                         () => { assert.strictEqual(parseCommand('ON', { type: 'boolean' }), true); assert.strictEqual(parseCommand('false', { type: 'boolean' }), false); assert.strictEqual(parseCommand('maybe', { type: 'boolean' }), null); });
test('parseCommand number begrenzt',                 () => { assert.strictEqual(parseCommand('150', { type: 'number', min: 0, max: 100 }), 100); assert.strictEqual(parseCommand('-5', { type: 'number', min: 0, max: 100 }), 0); assert.strictEqual(parseCommand('abc', { type: 'number' }), null); assert.strictEqual(parseCommand('', { type: 'number' }), null); });
test('isBrightness',                                () => { assert.ok(isBrightness('a.0.g.brightness', grpBri)); assert.ok(!isBrightness('a.0.g.power', { type: 'number', write: true, role: 'value.power' })); assert.ok(!isBrightness('a.0.g.brightness', { ...grpBri, write: false })); });
test('stateTopicOf',                                 () => assert.strictEqual(stateTopicOf('licht-gruppen.0.Esszimmer.Lampe1.on', 'iob2ha'), 'iob2ha/licht-gruppen/Esszimmer/Lampe1/on'));

console.log(`\n${passed} bestanden, ${failed} fehlgeschlagen`);
if (failed > 0) process.exit(1);
