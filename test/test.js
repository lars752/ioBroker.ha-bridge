'use strict';

/**
 * Unit-Tests für lib/mapping.js – ohne ioBroker und ohne MQTT.
 */

const assert  = require('assert');
const { buildDiscovery, availTopic } = require('../lib/mapping');

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
test('uniqueId enthält Datenpunkt',     () => assert(shellyPower.uniqueId.includes('TotalActivePower')));
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

console.log(`\n${passed} bestanden, ${failed} fehlgeschlagen`);
if (failed > 0) process.exit(1);
