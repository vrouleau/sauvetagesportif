# Timing Console Integration — Research Notes & Strategy

## Question investigated

Whether to build a native (TCP or serial) integration with electronic touchpad
timing consoles — specifically Swiss Timing Quantum and Daktronics OmniSport
2000 — as an alternative/complement to the existing Splash-file-protocol
bridge (`packages/meet-app/src/main/quantum.ts`) and the manual/OCR timing
workflow.

## Findings

### Swiss Timing Quantum

- No public SDK or API. Swiss Timing only publishes user/installation manuals
  (swisstiming.com/download), not developer documentation.
- The interface this repo already implements (`splash_send.txt` /
  `splash_receive.txt`, polled every 150ms, XML payloads framed by
  `SEND NAMES;START…END` / `ASK NAMES` / `STATUS;` / `SEND RESULTS;START…END`)
  is Quantum's **"DH Splash protocol"** — a vendor-specific option baked into
  Quantum's own software, named after Splash Meet Manager. Quantum ships
  similar named variants for other meet-manager vendors (e.g. "DH OSM6" for
  Swimify, over serial RS-422).
- No public spec exists for this file protocol. It was not derived from
  documentation — it matches this project's established pattern of deriving
  behavior by observing a real Splash/Quantum pairing directly (same approach
  used to capture the real Splash Postgres schema for
  `splash-schema-contract.test.ts`).
- Splash's own release notes mention a newer **"Swiss Timing Quantum
  Interface 2.0"** (Nov 2020) that replaced the shared-file exchange with
  UDP/TCP. That protocol is not publicly documented either — Splash is the
  only side that speaks it.
- Conclusion: any native Quantum integration (file-based or TCP) requires
  either reverse-engineering a live Quantum console (not available to us) or
  a Swiss Timing/Splash partnership. Not worth pursuing further.

### Daktronics OmniSport 2000

- Connects over genuine RS-232 serial (J5 RTD PORT / J6 RESULTS PORT), not
  USB or TCP natively. A USB-to-serial adapter cable bridges to a modern
  laptop (this is the "serial-to-USB cable" workflow used with Splash).
- Port/protocol selection (bidirectional "OmniSport 2000/6000" vs.
  unidirectional "CTS") is documented in Daktronics' public Operation Manual
  PDFs — more open than Quantum, since Daktronics wants third-party
  scoreboards/displays to integrate against it.
- Full byte-level framing is not fully self-explanatory from the manuals:
  hobbyists have published "decoding" writeups to work out the actual wire
  format, implying the public docs cover configuration but not a complete
  low-level spec.
- Conclusion: more tractable than Quantum if ever needed, but still not a
  clean public API — same "not worth building against" call for now.

## Decision

No value in investing further time reverse-engineering or building native
TCP/serial integrations for either console. Two supported paths cover the
real cases:

1. **Meets with a Daktronics/Omega or Swiss Timing Quantum console present**
   (touchpad timing available): use the existing meet-app ↔ Splash
   interworking — run real Splash Meet Manager against the console using its
   already-supported (if undocumented) interfaces, then move data between
   Splash and meet-app/team-app via the existing LXF round-trip (see root
   `CLAUDE.md` — meet setup / entries / results LXF exchange).

2. **Pool meets with no touchpads** (the common case for this app): use
   meet-app's own manual timing workflow — lane judges write down times,
   entered/averaged in meet-app, with the printed-sheet + camera photo-scan
   + OCR pipeline (`packages/meet-app/CLAUDE.md`, "Timing Sheet OCR
   Scanning") handling capture and validation instead of a live console feed.

No code changes result from this — this is a scope decision, documented here
so the Quantum/OmniSport research isn't repeated later.
