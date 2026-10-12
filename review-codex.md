# Code Review

Scope: full application source (`js/`, `worker/src/`, `index.html`, and deployment/test configuration) as currently present in the working tree.

## Findings

### High: inactive seats can be claimed without proving room membership

`GET /api/room/seats` exposes opaque references for inactive seats, and `POST /api/room/claim` accepts a new player id plus that reference. The claim handler verifies only that the target seat is inactive; it never checks that the caller already belongs to the room. Anyone who knows the room code can take over an inactive seat, including the host seat after the 10-second inactivity threshold, and receive a fresh token. This allows host takeover during a brief disconnect. Require proof of room membership or host approval before transferring a seat; otherwise make inactive-seat recovery an explicit, accepted trust policy. See `worker/src/Room.js:483` and `worker/src/Room.js:502`.

### High: legacy players remain impersonable by public player id

When a player has no stored token, `checkToken` accepts any request. The create/join handlers issue tokens only when the client opts into `authVersion: 1`, while sanitized room state publishes player ids to connected room members. A legacy client/seat can therefore be impersonated through REST or WebSocket by someone who learns its id; this includes host actions when the host seat is legacy. This is documented as a compatibility phase, but it remains a security gap until old clients/seats are migrated or rejected. See `worker/src/Room.js:289`, `worker/src/Room.js:358`, `worker/src/Room.js:419`, and `worker/src/Room.js:906`.

## Review Notes

- Reviewed the frontend rendering, state persistence, worker routing, room lifecycle/actions, WebSocket authentication, rate limiting, UAT build, and Playwright configuration.
- No automated tests were run for this review.
