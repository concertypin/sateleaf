# Keepalive regression benchmark

Measured on 2026-10-05 with Node 26.5.0 on the local Windows machine.
Baseline: `main` at `f05045c`. Candidate: initial keepalive commit `9449b08`.

Both versions used the same lockfile and benchmark harness. Each process warmed
up for 10 requests, then measured 30 requests. Three sequential before/after
pairs were run, giving 90 measured requests per version and scenario.

The PDF scenario used a synthetic 175,000-character Korean/English conversation,
font size 1, maximum mode, and `nocache`. This is not a token-count measurement
or the user's actual prompt. The mocked upstream returned 1,000 complete SSE
chunks, totaling 24,000 bytes, immediately. Each response was fully consumed.
The stream-only scenario used the same response with no PDF transformation.
Console writes were suppressed; JSON timing serialization still occurred.

Arithmetic means across the three runs:

| Scenario / metric                    | Before (ms) | After (ms) | Difference (ms) |
| ------------------------------------ | ----------: | ---------: | --------------: |
| PDF request through response headers |      25.636 |     25.291 |          -0.345 |
| PDF request through full response    |      26.098 |     26.836 |          +0.738 |
| Stream-only through response headers |       0.210 |      0.306 |          +0.096 |
| Stream-only through full response    |       0.572 |      1.664 |          +1.092 |

Per-run median / p95 for full responses:

| Scenario    | Run | Before median / p95 (ms) | After median / p95 (ms) |
| ----------- | --: | -----------------------: | ----------------------: |
| PDF         |   1 |          26.115 / 30.978 |         26.818 / 32.063 |
| PDF         |   2 |          26.289 / 31.261 |         26.649 / 31.112 |
| PDF         |   3 |          25.444 / 31.727 |         26.522 / 29.893 |
| Stream-only |   1 |            0.543 / 1.246 |           1.899 / 2.930 |
| Stream-only |   2 |            0.607 / 0.958 |           1.503 / 2.787 |
| Stream-only |   3 |            0.517 / 0.837 |           1.299 / 2.625 |

The relay adds measurable CPU overhead for cancellation, timing, and safe SSE
boundary tracking. PDF preparation remained similar in this workload. The test
does not prove zero regression or improved PDF speed. It does not include Heroku
CPU contention, actual upstream latency, network transport, console output cost,
long idle heartbeat waits, or concurrent-request behavior.

Runtime `Server-Timing`, completion trailers, and structured logs distinguish
preparation, transformation, upstream headers, and first upstream body wait.
The keepalive starts after upstream headers; it cannot protect header waits or
PDF preparation exceeding Heroku's initial response deadline in that initial commit.

## Follow-up: opt-out and early-response modes

Measured with the same workload, warmup, and three rounds of 30 samples per mode
after adding `nokeepalive`, `earlykeepalive`, immediate default SSE comments, and
actual upstream first-byte timing. Baseline is now `9449b08`; candidate is the
follow-up `local/sse-keepalive` working tree. The initial synthetic keepalive
comment is removed only when verifying that the actual upstream payload remains
identical. The whole response, including that comment, is consumed and timed.

| Version / mode          | PDF through headers (ms) | PDF full response (ms) | Stream-only full response (ms) |
| ----------------------- | -----------------------: | ---------------------: | -----------------------------: |
| Before, `9449b08`       |                   24.703 |                 26.030 |                          1.085 |
| After, default          |                   25.562 |                 26.876 |                          1.254 |
| After, `nokeepalive`    |                   23.446 |                 24.559 |                          1.133 |
| After, `earlykeepalive` |                    0.455 |                 24.873 |                          1.403 |

Default mode adds about 0.85ms to the PDF-inclusive mean and 0.17ms to the
1,000-chunk stream-only mean in these runs. This is not evidence of zero overhead.
The apparent lower PDF-inclusive times in other modes fall within the observed
run-to-run variation and do not establish faster PDF generation. Early headers
arrive before preparation, so their short duration does not measure model
readiness. Runtime `first_upstream_byte` excludes proxy-generated comments and
errors, but includes any actual upstream bytes, including upstream SSE comments.

Normal mode protects slow first body bytes once upstream headers arrive;
`earlykeepalive` additionally protects preparation and upstream header waits.
Neither protects dyno startup before the handler runs or synchronous event-loop
blocking after the initial comment. Actual Node HTTP tests separately verify
that the early headers and bytes are written before synchronous preparation.
