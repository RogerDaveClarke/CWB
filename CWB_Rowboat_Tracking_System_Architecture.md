graph TD
    %% Boat Tracker Node
    subgraph Boat Tracker Node [Rowboat Tracking Node]
        A[5W ETFE Flexible Solar Panel] -->|Raw Solar V/I| B[CN3083 Constant-Current Controller]
        B[CN3083 Constant-Current Controller] -->|Regulated Trickle Charge| C[4.8V AA NiCad Battery Pack]
        C[4.8V AA NiCad Battery Pack] -->|Unregulated VCC| D[Seeed Studio XIAO SAMD21]
        D[Seeed Studio XIAO SAMD21] -->|I2C / Qwiic| E[u-blox NEO-M9N GPS]
        D[Seeed Studio XIAO SAMD21] -->|I2C / Qwiic| R[RV-1805 RTC]
        R[RV-1805 RTC] -->|15-minute wake on D5| D[Seeed Studio XIAO SAMD21]
        D[Seeed Studio XIAO SAMD21] -->|I2C / STEMMA QT| T[AMG8833 Thermal Array]
        D[Seeed Studio XIAO SAMD21] -->|I2C / STEMMA QT| X[LIS3DH Accelerometer]
        D[Seeed Studio XIAO SAMD21] -->|SPI Communication Bus| F[Wio SX1262 LoRa Transceiver]
        E[u-blox NEO-M9N GPS] -->|NMEA Serial Strings| D[Seeed Studio XIAO SAMD21]
    end

    %% RF Data Link
    F[Wio SX1262 LoRa Transceiver] -->|915 MHz LoRaWAN RF Payload| G((Open Air Link - South Lake Union))

    %% Base Station Gateway
    subgraph Base Station Gateway [CWB Boathouse Base Station]
        G((Open Air Link - South Lake Union)) -->|RF Wave Capture| H[IP67 915MHz Omnidirectional Antenna]
        H[IP67 915MHz Omnidirectional Antenna] -->|Coaxial Lead| I[RAK7289V2 WisGate Edge Pro]
        J[40W Off-Grid Rigid Solar Panel] -->|DC Input| K[MPPT Solar Charge Controller]
        K[MPPT Solar Charge Controller] -->|12V Steady Feed| L[12V 18Ah Sealed Lead-Acid Battery]
        L[12V 18Ah Sealed Lead-Acid Battery] -->|Power Delivery| I[RAK7289V2 WisGate Edge Pro]
    end

    %% Network & Application Cloud Routing
    I[RAK7289V2 WisGate Edge Pro] -->|Cellular Backhaul / Public Internet| M[The Things Network v3 Cloud]
    M[The Things Network v3 Cloud] -->|Payload Formatter / JavaScript Decryption| N[JSON Structured Telemetry Stream]
    N[JSON Structured Telemetry Stream] -->|Secure MQTT WebSockets| O[React Web Dashboard Application]

    %% Styles
    style A fill:#f9f,stroke:#333,stroke-width:2px
    style C fill:#bbf,stroke:#333,stroke-width:2px
    style I fill:#f96,stroke:#333,stroke-width:2px
    style O fill:#9f9,stroke:#333,stroke-width:2px

    %% s63 s64 s65 s66 s67 s68 s69 s70 s71 s72
    %% s108 s109 s110 s111 s112 s113 s114 s115 s116 s117 s118 s119 s120 s121 s122 s123 s124 s125 s126 s127 s128 s129 s130 s131 s132 s133 s134 s135 s136 s137 s138 s139 s140 s141 s142 s143 s144 s145 s146 s147 s148 s149 s150 s151 s152 s153 s154 s155 s156 s157 s158 s159 s160
    %% s30 s31 s32 s74 s75 s33 s10 s76 s77 s78 s34 s79 s35 s80 s36 s37 s9 s81 s82 s38 s83 s84 s39 s85 s86 s40 s41 s87 s42 s43 s88