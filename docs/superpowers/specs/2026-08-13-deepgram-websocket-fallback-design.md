# Deepgram WebSocket Automatic Fallback Design

## Goal

Prevent the translator from remaining indefinitely in `连接中` when the browser cannot directly reach `wss://api.deepgram.com`, while preserving the lowest-latency direct path for networks where it works.

## Selected approach

Use direct-first automatic fallback:

1. Request the existing short-lived translation token and Deepgram JWT.
2. Attempt the existing direct Deepgram WebSocket connection.
3. Wait at most 5 seconds for `open`.
4. If direct connection has not opened, close it and connect to the Worker WebSocket relay.
5. Start sending microphone audio only after one connection opens.

The fallback is attempted once per Start action. It must not create simultaneous active recognition sessions.

## Frontend behavior

The frontend keeps the current microphone capture and audio encoding pipeline.

- Initial status: `连接中...`
- Fallback status after 5 seconds: `直连超时，切换备用线路...`
- Success status: `正在识别`
- Final failure status: `连接失败，请重试`

The Start button remains disabled while either connection attempt is active. On final failure, all audio and WebSocket resources are closed and the Start button is enabled again.

## Worker relay

Add a WebSocket endpoint at `/listen`.

The browser connects using WebSocket subprotocols containing a fixed protocol identifier and the existing short-lived translation token. The Worker validates the token using the same signature, origin, IP, and expiry checks as `/translate` before opening an upstream Deepgram WebSocket.

The Worker connects upstream to the same Deepgram `/v1/listen` URL and forwards binary audio and JSON control frames in both directions. The permanent Deepgram API key remains only in the Cloudflare Secret binding.

## Security boundaries

- Never place `DEEPGRAM_API_KEY` in HTML, JavaScript, URLs, logs, or responses.
- Reject missing, invalid, expired, wrong-origin, or wrong-IP translation tokens before upgrading.
- Allow only the fixed Deepgram host and a fixed allowlist of recognition query parameters.
- Preserve the current input limits and origin allowlist.
- Do not include the short-lived token in a query string.

## Failure handling

- Direct timeout triggers one relay attempt.
- Direct failure before 5 seconds triggers the relay immediately.
- Relay authentication failure returns a non-101 response and restores the UI.
- Upstream Deepgram failure closes the browser socket with a server-error close code.
- Stop closes whichever socket is active and releases the microphone and audio context.

## Latency behavior

Successful direct connections are unchanged and gain no extra network hop. Only blocked direct connections use the Worker relay. The 5-second timeout applies only when the browser produces neither `open` nor `error`; explicit direct errors fall back immediately.

## Verification

The change is accepted only when all of the following pass:

1. `/token` returns both the translation token and Deepgram temporary JWT.
2. Direct Deepgram WebSocket handshake still opens with the JWT.
3. Worker `/listen` rejects a missing or invalid translation token.
4. Worker `/listen` accepts a valid token and completes an upstream Deepgram handshake.
5. The live GitHub Pages build contains the fallback client code.
6. A failed connection restores Start and releases microphone resources.

