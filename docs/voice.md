# Voice: architecture direction (NOT IMPLEMENTED)

> **Status: not implemented.** DASH AI has no voice input or output today. No microphone, speaker,
> voice picker or voice setting exists in the Web or Android apps, and none may be shown until the
> pieces below are built and verified. This document records the Director's direction so future work
> starts from it.

## DASH Signature Voice

The future default voice of DASH AI is **DASH Signature Voice**, based on the Director's real voice.

The governing rule: **make the Director's voice clearer, cleaner, richer and more consistent — not
different.**

- **Preserve:** the deep tone, the accent, the cadence and rhythm, the warmth.
- **Improve only:** clarity (noise, room echo, plosives, sibilance), cleanliness (artefacts between
  phrases), richness (a fuller low end without changing pitch), and consistency (level and timbre across
  long answers and sessions).
- **Never:** change the accent, "neutralise" or Americanise it, shift pitch or gender, speed it up to
  sound more "assistant-like", or blend it with a stock voice.

Before any build, the Director approves: the recording plan, the processing chain (a short A/B of raw vs
processed takes), the consent and usage terms for the voice, and the first synthesised samples.

## DASH-owned voice identities

People choose among **DASH-owned voice identities**, never provider voices. Names below are illustrative
only and not final: Calm, Warm, Deep, Bright, Expressive. DASH Signature Voice is the default.

- A voice identity is a DASH product asset: id, display name, description, sample, and the internal
  engine configuration behind it.
- The vendor or model behind an identity is internal, like reasoning providers
  ([provider-neutrality.md](provider-neutrality.md)). The UI never says which speech vendor is used.

## Architecture

Voice is **independent of the reasoning provider**: any answer, from whichever provider DASH AI routed
to, can be spoken in any DASH voice.

```
 microphone ─► speech-to-text adapter ─► text ─► DASH AI chat (routing, tools, history) ─► answer text
                                                                                       │
                                     DASH voice identity (e.g. Signature) ─► text-to-speech adapter ─► audio
```

- **Server-side adapters** (like `ProviderAdapter` today): `SpeechToTextAdapter` and
  `TextToSpeechAdapter`, each with internal ids, retries and failover. Keys stay on the server.
- **Voice registry:** DASH voice identity → engine + voice configuration per adapter. Swapping a vendor
  changes the registry, not the apps.
- **Contracts:** consumer responses carry the DASH voice identity id only. No vendor or model fields
  (same rule as `PROVIDER_DETAILS=hidden`), enforced by the leak tests.
- **Streaming:** answers are spoken sentence by sentence as text streams; Stop stops both.
- **Privacy:** audio is processed to text and not kept by default; any retention needs explicit consent
  and is listed in `data-inventory.md`. The processor disclosure covers speech vendors.
- **Accessibility:** captions always available; voice never replaces text.

## Internal visibility

A future Super Admin may see, per request: STT/TTS vendor, model, latency, characters/seconds processed
and cost, next to the reasoning-provider data already recorded. This is internal only.

## What must be true before anything ships

1. Director approval of DASH Signature Voice samples ("clearer, cleaner, richer, more consistent — not
   different").
2. Adapters behind the voice registry, with leak tests proving no vendor appears in responses.
3. Web and Android UI (voice input, playback, voice picker in Settings) built and tested on real devices.
4. Privacy and consent text updated.

Until then: no voice UI, no voice setting, and no claim anywhere that voice exists.
