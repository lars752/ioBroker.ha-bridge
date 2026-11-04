# ioBroker.ha-bridge

Überträgt ioBroker-Datenpunkte automatisch per **MQTT Discovery** zu Home Assistant.

Die Entitäten erscheinen in HA ohne manuelle Konfiguration – mit korrekten Namen, Einheiten und Device-Klassen. Alle Datenpunkte aus einem Adapter werden in HA unter einem gemeinsamen **Gerät** gruppiert.

## Funktionsprinzip

```
ioBroker                          MQTT-Broker               Home Assistant
─────────────────────────────     ───────────────────        ─────────────────
shelly-gruppen.0.*          ──►  homeassistant/sensor/      Gerät: shelly-gruppen
ecoflow-gruppen.0.*         ──►  …/config  (Discovery)      Gerät: ecoflow-gruppen
growatt-bms.0.*             ──►  iob2ha/…  (State)          Gerät: growatt-bms
```

Beim Start sendet der Adapter für jeden Datenpunkt eine Discovery-Nachricht. Danach werden Wertänderungen sofort weitergeleitet. Ein Heartbeat schickt alle konfigurierten Sekunden alle Werte erneut, damit HA nach einem Neustart immer aktuelle Daten hat.

## Voraussetzungen

- MQTT-Broker (z. B. Mosquitto) erreichbar von ioBroker und HA
- HA: Einstellungen → Integrationen → MQTT mit demselben Broker
- Die Quell-Adapter (`shelly-gruppen`, `ecoflow-gruppen`, `growatt-bms`) müssen laufen

## Installation

```
iobroker url https://github.com/lars752/ioBroker.ha-bridge
```

## Konfiguration

### MQTT-Broker
| Einstellung | Standard | Bedeutung |
|---|---|---|
| Broker-Adresse | `localhost` | IP oder Hostname des MQTT-Brokers |
| Port | `1883` | MQTT-Port (TLS: 8883) |
| TLS | — | MQTTS aktivieren |
| Benutzername/Passwort | — | Passwort wird verschlüsselt gespeichert |

### Home Assistant
| Einstellung | Standard | Bedeutung |
|---|---|---|
| Discovery Prefix | `homeassistant` | Muss mit HA-Einstellung übereinstimmen |
| State Topic Prefix | `iob2ha` | Namensraum für Zustandsthemen |
| Retain (Discovery) | ✓ | HA findet Entitäten nach Neustart sofort |
| Heartbeat-Intervall | `30` s | Alle Werte periodisch erneut senden |

### Quell-Adapter
Die Tabelle enthält die zu spiegelnden ioBroker-Instanzen, z. B.:

| Aktiv | Steuern | Instanz |
|---|---|---|
| ✓ | | `shelly-gruppen.0` |
| ✓ | | `ecoflow-gruppen.0` |
| ✓ | | `growatt-bms.0` |
| ✓ | ✓ | `licht-gruppen.0` |

### Steuern (Home Assistant → ioBroker)
Ist bei einer Instanz „Steuern“ gesetzt, werden ihre **beschreibbaren** Datenpunkte in Home Assistant bedienbar. Standard ist aus (nur Anzeige).

| ioBroker-Datenpunkt | Entität in Home Assistant |
|---|---|
| boolesch, beschreibbar, Rolle `switch.light` oder mit Helligkeit im selben Ordner (z. B. `Esszimmer.on` + `Esszimmer.brightness`) | `light` mit Helligkeit (0–100 bzw. `max` des Datenpunkts) |
| boolesch, beschreibbar, sonst (nicht `indicator`/`button`/`sensor`/`value`) | `switch` |
| Zahl, beschreibbar, mit `min` und `max` | `number` |
| alles andere, auch nicht beschreibbare Datenpunkte | wie bisher `sensor` / `binary_sensor` |

Befehle laufen über `<State-Topic>/set`, z. B. `iob2ha/licht-gruppen/Esszimmer/on/set` (`ON`/`OFF`/`true`/`false`) und `…/Esszimmer/brightness/set` (Zahl, wird auf `min`/`max` begrenzt). Der Adapter schreibt sie mit `ack=false` in den Datenpunkt, die Quelle verarbeitet sie also wie einen Befehl aus der Admin-Oberfläche. Ungültige Befehle werden mit Warnung ignoriert, Topics, die der Adapter nicht selbst angelegt hat, ebenfalls. Wird „Steuern“ später abgeschaltet, ersetzt der Adapter die Einträge wieder durch Sensoren (alte Discovery-Einträge werden entfernt).

Hinweis: Wer Schreibrechte auf den MQTT-Broker hat, kann diese Datenpunkte schalten. Den Broker deshalb absichern (Benutzer/Passwort, TLS) und „Steuern“ nur für Quellen aktivieren, denen Home Assistant vertrauen darf.

## MQTT-Topic-Struktur

```
homeassistant/sensor/<unique_id>/config          ← Discovery (retain)
iob2ha/shelly-gruppen/wohnung_links/Meter1/TotalActivePower   ← State
iob2ha/shelly-gruppen/availability               ← online / offline
```

## Entitäten in Home Assistant

Nach dem ersten Start erscheinen unter Einstellungen → Geräte die drei Geräte automatisch:

- **shelly-gruppen**: `wohnung_links.Meter1.TotalActivePower` (W), `wohnung_links.Meter1.online` usw.
- **ecoflow-gruppen**: `PV.WR1.InvOutputWatts` (W), `PV.WR1.Power` (W) usw.
- **growatt-bms**: `SoC` (%), `Voltage` (V), `Current` (A), `Max_Temperature` (°C) usw.

## Entwicklung

```bash
npm install
npm test
```

## Changelog

### 1.1.0
- Neu: „Steuern“ je Quell-Instanz: beschreibbare Datenpunkte erscheinen in Home Assistant als `light` (mit Helligkeit), `switch` oder `number` und werden per MQTT-Befehl in ioBroker geschrieben (ack=false)

## Lizenz

MIT
