# Slot-naming corpus run — 2026-05-27T00:48:42.507Z

Fixtures: 44
Total slots: 465
  Hits (algo == expected, including both-null): 271 (58.3%)
  Misses (expected name, algo got null or wrong): 182 (39.1%)
  False positives (expected null, algo named): 12 (2.6%)

Total cohorts (expected): 18
  Hits (correct kind, members, and name): 10
  Misses: 8

## Per-category accuracy

| Category | Fixtures | Slots | Hit | Miss-NoName | Miss-WrongName | FalsePos |
|---|---|---|---|---|---|---|
| `app/go` | 5 | 33 | 31 | 2 | 0 | 0 |
| `app/java` | 5 | 36 | 20 | 13 | 3 | 0 |
| `app/node` | 4 | 44 | 32 | 9 | 1 | 2 |
| `app/python` | 5 | 38 | 28 | 9 | 0 | 1 |
| `app/ruby` | 2 | 22 | 10 | 9 | 3 | 0 |
| `app/rust` | 2 | 15 | 10 | 4 | 0 | 1 |
| `cloud/aws` | 2 | 21 | 0 | 14 | 7 | 0 |
| `database/mysql` | 1 | 12 | 6 | 5 | 1 | 0 |
| `database/postgres` | 1 | 9 | 0 | 7 | 1 | 1 |
| `firewall` | 1 | 19 | 9 | 5 | 5 | 0 |
| `infra/load-balancer` | 1 | 12 | 1 | 11 | 0 | 0 |
| `infra/web-server` | 1 | 9 | 1 | 8 | 0 | 0 |
| `k8s/audit` | 3 | 36 | 30 | 0 | 5 | 1 |
| `k8s/container` | 4 | 65 | 36 | 25 | 1 | 3 |
| `os/syslog` | 1 | 8 | 0 | 7 | 1 | 0 |
| `os/windows` | 1 | 12 | 2 | 10 | 0 | 0 |
| `security/falco` | 3 | 25 | 21 | 2 | 2 | 0 |
| `security/ossec` | 2 | 49 | 34 | 9 | 3 | 3 |

## Per-fixture details

### `spring-boot-logback-default` — Spring Boot application using default logback pattern (app/java)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `2026-05-26 14:32:18.421` | `timestamp` | `timestamp` | OK | format_spec | Leading ISO-like timestamp at start of logback default pattern. |
| 1 | `INFO` | `level` | `null` | miss_no_name | — | Five-char level token in default logback layout after timestamp. |
| 2 | `12453` | `pid` | `null` | miss_no_name | — | Spring Boot default pattern emits PID after level. |
| 3 | `main` | `thread` | `null` | miss_no_name | — | Bracketed token after '---' in logback pattern is the thread name. |
| 4 | `o.s.b.w.embedded.tomcat.Tomcat` | `logger` | `null` | miss_no_name | — | Logger name appears between thread bracket and the colon separator. |
| 5 | `Tomcat started on port(s): 808` | `message` | `null` | miss_no_name | — | Free-text message after the ' : ' separator. |

### `spring-boot-mdc-traceid` — Spring Boot with MDC-injected trace fields (app/java)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `2026-05-26 14:35:02.901` | `timestamp` | `timestamp` | OK | format_spec | Standard leading timestamp. |
| 1 | `INFO` | `level` | `null` | miss_no_name | — | Log level token. |
| 2 | `order-service` | `service` | `null` | miss_no_name | — | First element of Sleuth MDC bracket is the application/service name. |
| 3 | `7f3b2c1d4e5f6a7b` | `trace_id` | `null` | miss_no_name | — | Second element of the Sleuth bracket is the trace ID. |
| 4 | `a1b2c3d4e5f60718` | `span_id` | `null` | miss_no_name | — | Third element of the Sleuth bracket is the span ID. |
| 5 | `9821` | `pid` | `null` | miss_no_name | — | Process ID after MDC bracket. |
| 6 | `nio-8080-exec-1` | `thread` | `null` | miss_no_name | — | Thread name in second bracket. |
| 7 | `c.acme.order.OrderService` | `logger` | `null` | miss_no_name | — | Logger class name before ' : '. |
| 8 | `ORD-99821` | `id` | `id` | OK | kv_pair | Token following 'id=' in message. |
| 9 | `cust_42` | `customer_id` | `customer_id` | OK | kv_pair | Token following 'customerId=' normalized to snake_case. |
| 10 | `129.95` | `total` | `total` | OK | kv_pair | Token following 'total='. |

### `log4j2-json-layout` — Java service using Log4j2 JsonLayout (app/java)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `1748278342901` | `timeMillis` | `timeMillis` | OK | json_key | JSON key directly before colon. |
| 1 | `http-nio-8080-exec-4` | `thread` | `thread` | OK | json_key | JSON key 'thread'. |
| 2 | `ERROR` | `level` | `level` | OK | json_key | JSON key 'level'. |
| 3 | `com.acme.payments.StripeClient` | `loggerName` | `loggerName` | OK | json_key | JSON key 'loggerName'. |
| 4 | `charge declined` | `message` | `message` | OK | json_key | Top-level message key. |
| 5 | `0` | `thrown.commonElementCount` | `thrown.commonElementCount` | OK | json_key | Nested under 'thrown' object. |
| 6 | `card_declined` | `thrown.localizedMessage` | `thrown.localizedMessage` | OK | json_key | Nested under 'thrown'. |
| 7 | `card_declined` | `thrown.message` | `thrown.message` | OK | json_key | Nested message inside 'thrown' — must NOT collide with top-level message. |
| 8 | `com.stripe.exception.CardExcep` | `thrown.name` | `thrown.name` | OK | json_key | Exception class name inside thrown object. |
| 9 | `u_7781` | `contextMap.userId` | `contextMap.userId` | OK | json_key | MDC entry under contextMap. |
| 10 | `req_abc123` | `contextMap.requestId` | `contextMap.requestId` | OK | json_key | MDC entry under contextMap — sibling pollution test (must pick requestId not use |

### `java-stacktrace-at-line` — JVM exception stacktrace 'at' frame (app/java)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `com.acme.order.OrderService` | `class` | `null` | miss_no_name | — | Fully-qualified class name before the method dot. |
| 1 | `validate` | `method` | `${}.java:$` | miss_wrong_name | format_spec | Method name before the opening parenthesis. |

### `structlog-json` — Python service using structlog JSON renderer (app/python)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `user signed in` | `event` | `event` | OK | json_key | JSON key 'event' precedes value. |
| 1 | `info` | `level` | `level` | OK | json_key | JSON key 'level'. |
| 2 | `2026-05-26T14:32:18.421Z` | `timestamp` | `timestamp` | OK | json_key | JSON key 'timestamp'. |
| 3 | `9281` | `user_id` | `user_id` | OK | json_key | JSON key 'user_id'. |
| 4 | `10` | `null` | `ip` | false_positive | json_key | First IPv4 octet — no individual name; subsumed by cohort 'ip'. |
| 5 | `0` | `null` | `null` | OK | — | IPv4 octet — cohort member. |
| 6 | `4` | `null` | `null` | OK | — | IPv4 octet — cohort member. |
| 7 | `27` | `null` | `null` | OK | — | IPv4 octet — cohort member. |
| 8 | `sess_a1b2c3` | `session_id` | `session_id` | OK | json_key | JSON key 'session_id'. |

Cohorts:
  - OK: ipv4 cohort `ip` covers ["slot_4","slot_5","slot_6","slot_7"]

### `loguru-default` — Python loguru default format (app/python)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `2026-05-26 14:32:18.421` | `timestamp` | `timestamp` | OK | format_spec | Leading timestamp in loguru default. |
| 1 | `INFO` | `level` | `null` | miss_no_name | — | Padded level token between pipes. |
| 2 | `myapp.api` | `module` | `null` | miss_no_name | — | Loguru emits module:function:line; first colon-segment is module. |
| 3 | `create_user` | `function` | `null` | miss_no_name | — | Second colon-segment is function name. |
| 4 | `88` | `line` | `null` | miss_no_name | — | Third colon-segment is the source line number. |
| 5 | `Got error "ERROR: failed to co` | `message` | `null` | miss_no_name | — | Free-text message after ' - '. Adversarial: the inner quoted 'ERROR: failed to c |

### `django-request-log` — Django runserver request log (app/python)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `26/May/2026 14:32:18` | `timestamp` | `timestamp` | OK | format_spec | Bracketed timestamp at start. |
| 1 | `GET` | `method` | `null` | miss_no_name | — | First token inside the request quoted string. |
| 2 | `/api/orders/99821` | `path` | `null` | miss_no_name | — | Second token inside request quoted string. |
| 3 | `1` | `null` | `null` | OK | — | HTTP major version digit — no semantic name, semver-style multi-position. |
| 4 | `1` | `null` | `null` | OK | — | HTTP minor version digit. |
| 5 | `200` | `status` | `null` | miss_no_name | — | Status code follows the quoted request. |
| 6 | `1284` | `bytes` | `null` | miss_no_name | — | Response size, the trailing integer in CLF-style logs. |

### `fastapi-structured` — FastAPI service with structlog and request_id middleware (app/python)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `2026-05-26T14:32:18.421Z` | `timestamp` | `timestamp` | OK | json_key | Top-level JSON key timestamp. |
| 1 | `info` | `level` | `level` | OK | json_key | Top-level JSON key level. |
| 2 | `fastapi.access` | `logger` | `logger` | OK | json_key | Top-level JSON key logger. |
| 3 | `request completed` | `event` | `event` | OK | json_key | Top-level JSON key event. |
| 4 | `POST` | `http.method` | `http.method` | OK | json_key | Nested under http object — dotted path. |
| 5 | `/v1/charges` | `http.path` | `http.path` | OK | json_key | Nested under http object. |
| 6 | `201` | `http.status_code` | `http.status_code` | OK | json_key | Nested under http object. |
| 7 | `87.4` | `duration_ms` | `duration_ms` | OK | json_key | Top-level duration_ms key. |
| 8 | `req_01HXXY9TPK` | `request_id` | `request_id` | OK | json_key | Top-level request_id key — sibling test, must NOT pick duration_ms. |

### `zap-json` — Go service using uber-go/zap JSON encoder (app/go)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `info` | `level` | `level` | OK | json_key | JSON key level. |
| 1 | `1748278342.901` | `ts` | `ts` | OK | json_key | JSON key ts (zap timestamp field). |
| 2 | `http/server.go` | `caller` | `caller` | OK | json_key | caller field is 'file:line' inside the quoted string; the file part is the first |
| 3 | `142` | `line` | `null` | miss_no_name | — | Trailing integer after colon inside caller string. |
| 4 | `handled request` | `msg` | `msg` | OK | json_key | JSON key msg. |
| 5 | `GET` | `method` | `method` | OK | json_key | JSON key method. |
| 6 | `/healthz` | `path` | `path` | OK | json_key | JSON key path. |
| 7 | `200` | `status` | `status` | OK | json_key | JSON key status. |
| 8 | `3.21` | `latency_ms` | `latency_ms` | OK | json_key | JSON key latency_ms. |
| 9 | `4bf92f3577b34da6a3ce929d0e0e47` | `trace_id` | `trace_id` | OK | json_key | JSON key trace_id. |

### `slog-text` — Go log/slog TextHandler default format (app/go)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `2026-05-26T14:32:18.421Z` | `time` | `time` | OK | kv_pair | Key 'time' precedes the '=' in slog text format. |
| 1 | `INFO` | `level` | `level` | OK | kv_pair | Key 'level' precedes the '='. |
| 2 | `shard rebalance complete` | `msg` | `null` | miss_no_name | — | Key 'msg' precedes the '="'. |
| 3 | `shard` | `null` | `null` | OK | — | Dynamic attribute key — name itself is the key, no static prefix. |
| 4 | `14` | `null` | `null` | OK | — | Dynamic attribute value — name is determined by slot 3. |
| 5 | `moved` | `null` | `null` | OK | — | Dynamic attribute key. |
| 6 | `128` | `null` | `null` | OK | — | Dynamic attribute value paired with slot 5. |
| 7 | `duration` | `null` | `null` | OK | — | Dynamic attribute key. |
| 8 | `2.341s` | `null` | `null` | OK | — | Dynamic attribute value paired with slot 7. |

### `slog-json` — Go log/slog JSONHandler (app/go)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `2026-05-26T14:32:18.421Z` | `time` | `time` | OK | json_key | Top-level time key. |
| 1 | `INFO` | `level` | `level` | OK | json_key | Top-level level key. |
| 2 | `served` | `msg` | `msg` | OK | json_key | Top-level msg key. |
| 3 | `GET` | `req.method` | `req.method` | OK | json_key | Nested under req object. |
| 4 | `/v2/items/4218` | `req.path` | `req.path` | OK | json_key | Nested under req object. |
| 5 | `200` | `resp.status` | `resp.status` | OK | json_key | Nested under resp object. |
| 6 | `1284` | `resp.bytes` | `resp.bytes` | OK | json_key | Nested under resp object — sibling pollution test (must NOT pick resp.status). |

### `cobra-cli-error` — Cobra/spf13 CLI error output (app/go)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `unknown flag: --verbosee` | `error` | `error` | OK | kv_pair | Free-text after 'Error: ' prefix maps to 'error' field. |

### `pino-json` — Node.js service using pino JSON (app/node)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `30` | `level` | `level` | OK | json_key | Top-level level (numeric in pino). |
| 1 | `1748278342901` | `time` | `time` | OK | json_key | Top-level time ms epoch. |
| 2 | `18221` | `pid` | `pid` | OK | json_key | Top-level pid. |
| 3 | `web-7f8c-q2x` | `hostname` | `hostname` | OK | json_key | Top-level hostname. |
| 4 | `req-19a` | `reqId` | `reqId` | OK | json_key | Top-level reqId. |
| 5 | `GET` | `req.method` | `req.method` | OK | json_key | Nested under req. |
| 6 | `/api/users/4218` | `req.url` | `req.url` | OK | json_key | Nested under req. |
| 7 | `192` | `null` | `req.remoteAddress` | false_positive | json_key | IPv4 octet inside req.remoteAddress — subsumed by cohort. |
| 8 | `168` | `null` | `null` | OK | — | IPv4 octet. |
| 9 | `4` | `null` | `null` | OK | — | IPv4 octet. |
| 10 | `27` | `null` | `null` | OK | — | IPv4 octet. |
| 11 | `200` | `res.statusCode` | `res.statusCode` | OK | json_key | Nested under res. |
| 12 | `12.4` | `responseTime` | `responseTime` | OK | json_key | Top-level responseTime. |
| 13 | `request completed` | `msg` | `msg` | OK | json_key | Top-level msg. |

Cohorts:
  - OK: ipv4 cohort `req.remoteAddress` covers ["slot_7","slot_8","slot_9","slot_10"]

### `winston-timestamp-meta` — Node.js winston with timestamp + JSON metadata (app/node)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `2026-05-26T14:32:18.421Z` | `timestamp` | `timestamp` | OK | format_spec | Leading ISO timestamp. |
| 1 | `warn` | `level` | `null` | miss_no_name | — | Bracketed level token. |
| 2 | `cache miss rate elevated` | `message` | `null` | miss_no_name | — | Text between ']: ' and the JSON metadata blob. |
| 3 | `checkout` | `service` | `service` | OK | json_key | JSON key 'service'. |
| 4 | `7af19b32` | `null` | `X-Request-ID` | false_positive | json_key | UUID segment; key is preserved case 'X-Request-ID'. Cohort handles the full UUID |
| 5 | `c0a2` | `null` | `null` | OK | — | UUID segment. |
| 6 | `4f33` | `null` | `null` | OK | — | UUID segment. |
| 7 | `8e3d` | `null` | `null` | OK | — | UUID segment. |
| 8 | `1cb5d3a0c0c1` | `null` | `null` | OK | — | UUID segment. |
| 9 | `0.42` | `cacheHitRate` | `cacheHitRate` | OK | json_key | JSON key 'cacheHitRate' — CamelCase preserved as-is. |

Cohorts:
  - OK: uuid cohort `X-Request-ID` covers ["slot_4","slot_5","slot_6","slot_7","slot_8"]

### `express-morgan-combined` — Express with morgan 'combined' format (app/node)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `10` | `null` | `null` | OK | — | IPv4 octet — cohort member. |
| 1 | `0` | `null` | `null` | OK | — | IPv4 octet. |
| 2 | `4` | `null` | `null` | OK | — | IPv4 octet. |
| 3 | `27` | `null` | `null` | OK | — | IPv4 octet. |
| 4 | `alice` | `remote_user` | `null` | miss_no_name | — | CLF/combined: the token after '-' and before the time bracket is the remote user |
| 5 | `26/May/2026:14:32:18 +0000` | `timestamp` | `timestamp` | OK | format_spec | Bracketed CLF timestamp. |
| 6 | `GET` | `method` | `null` | miss_no_name | — | First token of request quoted string. |
| 7 | `/api/orders/99821` | `path` | `null` | miss_no_name | — | Second token of request quoted string. |
| 8 | `1` | `null` | `null` | OK | — | HTTP major version digit — semver-style, no name. |
| 9 | `1` | `null` | `null` | OK | — | HTTP minor version digit. |
| 10 | `200` | `status` | `null` | miss_no_name | — | Status code after quoted request. |
| 11 | `1284` | `bytes` | `null` | miss_no_name | — | Response size. |
| 12 | `https://app.example.com/` | `referer` | `null` | miss_no_name | — | First trailing quoted string in CLF combined is Referer. |
| 13 | `Mozilla/5.0 (Macintosh; Intel ` | `user_agent` | `null` | miss_no_name | — | Second trailing quoted string in CLF combined is User-Agent. |

Cohorts:
  - PARTIAL: ipv4 cohort detected with right members, but name mismatch — expected `remote_addr`, got `ipv4`

### `rust-tracing-json` — Rust service using tracing-subscriber JSON formatter (app/rust)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `2026-05-26T14:32:18.421421Z` | `timestamp` | `timestamp` | OK | json_key | Top-level timestamp. |
| 1 | `INFO` | `level` | `level` | OK | json_key | Top-level level. |
| 2 | `connection established` | `fields.message` | `fields.message` | OK | json_key | Nested under fields. |
| 3 | `10` | `null` | `fields.peer` | false_positive | json_key | IPv4 octet inside fields.peer value — cohort member. |
| 4 | `0` | `null` | `null` | OK | — | IPv4 octet. |
| 5 | `4` | `null` | `null` | OK | — | IPv4 octet. |
| 6 | `27` | `null` | `null` | OK | — | IPv4 octet. |
| 7 | `51234` | `fields.peer_port` | `null` | miss_no_name | — | Port appended after ':' to fields.peer; name derived from parent key + 'port'. |
| 8 | `my_app::net` | `target` | `target` | OK | json_key | Top-level target key. |
| 9 | `accept_loop` | `span.name` | `span.name` | OK | json_key | Nested under span object. |
| 10 | `tokio-runtime-worker` | `threadName` | `threadName` | OK | json_key | Top-level threadName key — CamelCase preserved. |

Cohorts:
  - OK: ipv4 cohort `fields.peer` covers ["slot_3","slot_4","slot_5","slot_6"]

### `env-logger-default` — Rust env_logger default format (app/rust)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `2026-05-26T14:32:18Z` | `timestamp` | `timestamp` | OK | format_spec | Leading bracketed ISO timestamp. |
| 1 | `INFO` | `level` | `null` | miss_no_name | — | Second bracket field is level. |
| 2 | `my_app::server` | `module` | `null` | miss_no_name | — | Third bracket field is the module path. |
| 3 | `listening on 0.0.0.0:8080` | `message` | `null` | miss_no_name | — | Free text after closing bracket. |

### `rails-request-log` — Rails production request log (app/ruby)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `I` | `severity_char` | `null` | miss_no_name | — | Rails logger emits single severity char (D/I/W/E/F) before the bracket. |
| 1 | `2026-05-26T14:32:18.421421` | `timestamp` | `timestamp` | OK | format_spec | Bracketed timestamp. |
| 2 | `18221` | `pid` | `null` | miss_no_name | — | Token after '#' inside the bracket is process id. |
| 3 | `INFO` | `level` | `null` | miss_no_name | — | Level token before ' -- : '. |
| 4 | `a1b2c3d4` | `null` | `null` | OK | — | UUID segment — cohort member (request_id). |
| 5 | `e5f6` | `null` | `null` | OK | — | UUID segment. |
| 6 | `0718` | `null` | `null` | OK | — | UUID segment. |
| 7 | `9abc` | `null` | `null` | OK | — | UUID segment. |
| 8 | `def012345678` | `null` | `null` | OK | — | UUID segment. |
| 9 | `200` | `status` | `null` | miss_no_name | — | Status code after 'Completed '. |
| 10 | `OK` | `status_text` | `null` | miss_no_name | — | Status reason phrase paired with status code. |
| 11 | `87` | `duration_ms` | `null` | miss_no_name | — | Value before 'ms' after 'in '. |
| 12 | `12.3` | `views_ms` | `views` | miss_wrong_name | kv_pair | Value after 'Views: ' and before 'ms'. |
| 13 | `4.1` | `active_record_ms` | `active_record` | miss_wrong_name | kv_pair | Value after 'ActiveRecord: ' and before 'ms'. |
| 14 | `18421` | `allocations` | `allocations` | OK | kv_pair | Value after 'Allocations: '. |

Cohorts:
  - PARTIAL: uuid cohort detected with right members, but name mismatch — expected `request_id`, got `uuid`

### `sidekiq-job-log` — Sidekiq job processing log (app/ruby)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `2026-05-26T14:32:18.421Z` | `timestamp` | `timestamp` | OK | format_spec | Leading ISO timestamp. |
| 1 | `18221` | `pid` | `pid` | OK | kv_pair | Token after 'pid=' key. |
| 2 | `ovz` | `tid` | `tid` | OK | kv_pair | Token after 'tid=' key. |
| 3 | `INFO` | `level` | `null` | miss_no_name | — | Level before the first ': '. |
| 4 | `ChargeWorker` | `worker` | `null` | miss_no_name | — | Worker class name follows the level colon in Sidekiq format. |
| 5 | `7af19b32c0a24f33` | `jid` | `null` | miss_no_name | — | Token after 'JID-' prefix is the Sidekiq job ID. |
| 6 | `start` | `message` | `info` | miss_wrong_name | kv_pair | Final free-text after the trailing 'INFO: ' is the lifecycle message. |

### `k8s-audit-v1` — Kubernetes kube-apiserver audit log v1 (k8s/audit)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `Event` | `kind` | `kind` | OK | json_key | Top-level kind. |
| 1 | `audit.k8s.io/v1` | `apiVersion` | `apiVersion` | OK | json_key | Top-level apiVersion. |
| 2 | `RequestResponse` | `level` | `level` | OK | json_key | Top-level level. |
| 3 | `7af19b32` | `null` | `auditID` | false_positive | json_key | UUID segment of auditID — cohort member. |
| 4 | `c0a2` | `null` | `null` | OK | — | UUID segment. |
| 5 | `4f33` | `null` | `null` | OK | — | UUID segment. |
| 6 | `8e3d` | `null` | `null` | OK | — | UUID segment. |
| 7 | `1cb5d3a0c0c1` | `null` | `null` | OK | — | UUID segment. |
| 8 | `ResponseComplete` | `stage` | `stage` | OK | json_key | Top-level stage. |
| 9 | `/api/v1/namespaces/prod/pods/a` | `requestURI` | `requestURI` | OK | json_key | Top-level requestURI. |
| 10 | `delete` | `verb` | `verb` | OK | json_key | Top-level verb. |
| 11 | `system:serviceaccount:tooling:` | `user.username` | `user.username` | OK | json_key | Nested user object. |
| 12 | `u-9281` | `user.uid` | `user.uid` | OK | json_key | Nested user object — sibling test must NOT pick username. |
| 13 | `10` | `null` | `null` | OK | — | IPv4 octet of sourceIPs[0] — cohort. |
| 14 | `0` | `null` | `null` | OK | — | IPv4 octet. |
| 15 | `4` | `null` | `null` | OK | — | IPv4 octet. |
| 16 | `27` | `null` | `null` | OK | — | IPv4 octet. |
| 17 | `pods` | `objectRef.resource` | `objectRef.resource` | OK | json_key | Nested under objectRef. |
| 18 | `prod` | `objectRef.namespace` | `objectRef.namespace` | OK | json_key | Nested under objectRef. |
| 19 | `api-7f8c-q2x` | `objectRef.name` | `objectRef.name` | OK | json_key | Nested under objectRef. |
| 20 | `200` | `responseStatus.code` | `responseStatus.code` | OK | json_key | Nested under responseStatus — 2-level deep dotted path. |
| 21 | `2026-05-26T14:32:18.421421Z` | `requestReceivedTimestamp` | `requestReceivedTimestamp` | OK | json_key | Top-level requestReceivedTimestamp. |

Cohorts:
  - OK: uuid cohort `auditID` covers ["slot_3","slot_4","slot_5","slot_6","slot_7"]
  - PARTIAL: ipv4 cohort detected with right members, but name mismatch — expected `sourceIPs`, got `ipv4`

### `k8s-audit-deeply-nested` — k8s audit event with deeply nested annotations (k8s/audit)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `secrets` | `objectRef.resource` | `objectRef.resource` | OK | json_key | Nested under objectRef. |
| 1 | `kube-system` | `objectRef.namespace` | `objectRef.namespace` | OK | json_key | Nested under objectRef. |
| 2 | `bootstrap-token-abcd12` | `objectRef.name` | `objectRef.name` | OK | json_key | Nested under objectRef. |
| 3 | `v1` | `objectRef.apiVersion` | `objectRef.apiVersion` | OK | json_key | Nested under objectRef — sibling test with name/namespace/resource. |
| 4 | `allow` | `annotations.authorization.k8s.io/decision` | `annotations.authorization.k8s.io/decision` | OK | json_key | Key contains slashes and dots; preserve verbatim under annotations dotted path. |
| 5 | `RBAC: allowed by ClusterRoleBi` | `annotations.authorization.k8s.io/reason` | `annotations.authorization.k8s.io/reason` | OK | json_key | Annotation reason. Note the colon inside the VALUE 'RBAC: allowed by...' must no |
| 6 | `restricted:v1.28` | `annotations.pod-security.kubernetes.io/enforce-policy` | `annotations.pod-security.kubernetes.io/enforce-policy` | OK | json_key | Annotation with dashes and slashes; key preserved verbatim. |

### `kubelet-klog` — kubelet klog line (k8s/container)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `I` | `severity_char` | `null` | miss_no_name | — | klog single-letter severity (I/W/E/F) at start. |
| 1 | `0526 14:32:18.421421` | `timestamp` | `timestamp` | OK | format_spec | klog timestamp (MMDD HH:MM:SS.uuuuuu). |
| 2 | `18221` | `thread_id` | `null` | miss_no_name | — | klog emits thread/goroutine id after timestamp. |
| 3 | `kubelet.go` | `file` | `null` | miss_no_name | — | Source file before ':' in klog file:line. |
| 4 | `2421` | `line` | `null` | miss_no_name | — | Line number after ':' before ']'. |
| 5 | `SyncLoop ADD` | `message` | `null` | miss_no_name | — | Quoted message that follows ']'. |
| 6 | `source="api" pods=["prod/api-7` | `kv_attrs` | `null` | miss_no_name | — | Trailing key="value" attribute string with no further structure. |

### `otel-collector-stdout` — OpenTelemetry Collector container stdout (k8s/container)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `2026-05-26T14:32:18.821Z` | `timestamp` | `timestamp` | OK | format_spec | Leading ISO timestamp. |
| 1 | `error` | `level` | `null` | miss_no_name | — | Lowercase level token after first tab. |
| 2 | `opensearchexporter` | `component` | `null` | miss_no_name | — | Module/component name before '@v' version marker in zap caller. |
| 3 | `0` | `null` | `null` | OK | — | Semver major digit — no individual name. |
| 4 | `142` | `null` | `null` | OK | — | Semver minor digit. |
| 5 | `0` | `null` | `null` | OK | — | Semver patch digit. |
| 6 | `logger.go` | `file` | `null` | miss_no_name | — | Source file before ':' after version. |
| 7 | `36` | `line` | `null` | miss_no_name | — | Source line after ':'. |
| 8 | `Request failed.` | `message` | `null` | miss_no_name | — | Message text between tab and the trailing JSON blob. |
| 9 | `exporter` | `kind` | `kind` | OK | json_key | JSON key 'kind'. |
| 10 | `logs` | `data_type` | `data_type` | OK | json_key | JSON key 'data_type'. |
| 11 | `opensearch` | `name` | `name` | OK | json_key | JSON key 'name'. |
| 12 | `128` | `resource_logs` | `resource_logs` | OK | json_key | JSON key with a SPACE: 'resource logs' — normalize space to underscore. |
| 13 | `connection refused` | `error` | `error` | OK | json_key | JSON key 'error' — sibling test, must not collide with kind/data_type/name. |

### `ingress-nginx-access` — ingress-nginx access log default format (k8s/container)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `10` | `null` | `null` | OK | — | IPv4 octet — cohort member remote_addr. |
| 1 | `0` | `null` | `null` | OK | — | IPv4 octet. |
| 2 | `4` | `null` | `null` | OK | — | IPv4 octet. |
| 3 | `27` | `null` | `null` | OK | — | IPv4 octet. |
| 4 | `26/May/2026:14:32:18 +0000` | `time_local` | `timestamp` | miss_wrong_name | format_spec | nginx time_local field inside brackets. |
| 5 | `GET` | `method` | `null` | miss_no_name | — | First token of request quoted string. |
| 6 | `/api/orders/99821` | `path` | `null` | miss_no_name | — | Second token of request quoted string. |
| 7 | `2` | `null` | `null` | OK | — | HTTP major version digit. |
| 8 | `0` | `null` | `null` | OK | — | HTTP minor version digit. |
| 9 | `200` | `status` | `null` | miss_no_name | — | HTTP status code. |
| 10 | `1284` | `body_bytes_sent` | `null` | miss_no_name | — | Bytes sent after status (nginx body_bytes_sent). |
| 11 | `-` | `http_referer` | `null` | miss_no_name | — | First trailing quoted field is Referer. |
| 12 | `curl/8.4.0` | `http_user_agent` | `null` | miss_no_name | — | Second trailing quoted field is User-Agent. |
| 13 | `412` | `request_length` | `null` | miss_no_name | — | Numeric after UA — request_length in ingress-nginx default. |
| 14 | `0.012` | `request_time` | `null` | miss_no_name | — | Float after request_length — request_time. |
| 15 | `prod-api-80` | `proxy_upstream_name` | `null` | miss_no_name | — | Bracketed token after request_time is upstream name in ingress-nginx. |
| 16 | `10` | `null` | `null` | OK | — | Upstream IPv4 octet — cohort member. |
| 17 | `0` | `null` | `null` | OK | — | IPv4 octet. |
| 18 | `8` | `null` | `null` | OK | — | IPv4 octet. |
| 19 | `31` | `null` | `null` | OK | — | IPv4 octet. |
| 20 | `8080` | `upstream_port` | `null` | miss_no_name | — | Port after ':' on upstream addr. |
| 21 | `1284` | `upstream_response_length` | `null` | miss_no_name | — | Position 21 in default ingress-nginx pattern. |
| 22 | `0.011` | `upstream_response_time` | `null` | miss_no_name | — | Position 22 in default ingress-nginx pattern. |
| 23 | `200` | `upstream_status` | `null` | miss_no_name | — | Position 23 in default ingress-nginx pattern. |
| 24 | `a1b2c3d4e5f60718` | `req_id` | `null` | miss_no_name | — | Trailing 16-hex token is nginx req_id. |

Cohorts:
  - PARTIAL: ipv4 cohort detected with right members, but name mismatch — expected `remote_addr`, got `ipv4`
  - PARTIAL: ipv4 cohort detected with right members, but name mismatch — expected `upstream_addr`, got `ipv4`

### `falco-json-alert` — Falco JSON alert output (security/falco)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `14:32:18.421421421: Warning Se` | `output` | `output` | OK | json_key | Top-level output. |
| 1 | `Warning` | `priority` | `priority` | OK | json_key | Top-level priority. |
| 2 | `Read sensitive file untrusted` | `rule` | `rule` | OK | json_key | Top-level rule. |
| 3 | `2026-05-26T14:32:18.421421421Z` | `time` | `time` | OK | json_key | Top-level time. |
| 4 | `7f8cq2x` | `output_fields.container.id` | `output_fields.container.id` | OK | json_key | Nested dotted key under output_fields — preserve embedded dots. |
| 5 | `api` | `output_fields.container.name` | `output_fields.container.name` | OK | json_key | Nested dotted key under output_fields. |
| 6 | `1748278342421421421` | `output_fields.evt.time` | `output_fields.evt.time` | OK | json_key | Nested dotted key under output_fields. |
| 7 | `cat /etc/shadow` | `output_fields.proc.cmdline` | `output_fields.proc.cmdline` | OK | json_key | Nested dotted key under output_fields. |
| 8 | `cat` | `output_fields.proc.name` | `output_fields.proc.name` | OK | json_key | Nested dotted key under output_fields. |
| 9 | `root` | `output_fields.user.name` | `output_fields.user.name` | OK | json_key | Nested dotted key under output_fields — sibling test (must not pick proc.name). |

### `falco-text-format` — Falco text alert output (security/falco)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `14:32:18.421421421` | `time` | `timestamp` | miss_wrong_name | format_spec | Leading HH:MM:SS.nnnnnnnnn timestamp. |
| 1 | `Warning` | `priority` | `null` | miss_no_name | — | Priority token after ': '. |
| 2 | `Sensitive file opened for read` | `rule_text` | `null` | miss_no_name | — | Rule text between priority and opening paren. |
| 3 | `root` | `user` | `user` | OK | kv_pair | Token after 'user=' in parens. |
| 4 | `cat /etc/shadow` | `command` | `command` | OK | kv_pair | Token after 'command='. |
| 5 | `/etc/shadow` | `file` | `file` | OK | kv_pair | Token after 'file='. |
| 6 | `7f8cq2x` | `container_id` | `container_id` | OK | kv_pair | Token after 'container_id='. |
| 7 | `docker.io/library/alpine:3.19` | `image` | `image` | OK | kv_pair | Token after 'image=' — sibling test, must not pick container_id/file. |

### `ossec-alert-json` — OSSEC/Wazuh alert JSON (security/ossec)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `2026-05-26T14:32:18.421+0000` | `timestamp` | `timestamp` | OK | json_key | Top-level timestamp. |
| 1 | `10` | `rule.level` | `rule.level` | OK | json_key | Nested under rule. |
| 2 | `sshd: brute force trying to ge` | `rule.description` | `rule.description` | OK | json_key | Nested under rule. |
| 3 | `5712` | `rule.id` | `rule.id` | OK | json_key | Nested under rule. |
| 4 | `4` | `rule.firedtimes` | `rule.firedtimes` | OK | json_key | Nested under rule. |
| 5 | `true` | `rule.mail` | `rule.mail` | OK | json_key | Nested under rule. |
| 6 | `syslog` | `rule.groups` | `null` | miss_no_name | — | Element of rule.groups array — share parent key name. |
| 7 | `sshd` | `rule.groups` | `null` | miss_no_name | — | Element of rule.groups array. |
| 8 | `authentication_failed` | `rule.groups` | `null` | miss_no_name | — | Element of rule.groups array. |
| 9 | `008` | `agent.id` | `agent.id` | OK | json_key | Nested under agent. |
| 10 | `web-01` | `agent.name` | `agent.name` | OK | json_key | Nested under agent. |
| 11 | `10` | `null` | `agent.ip` | false_positive | json_key | IPv4 octet of agent.ip — cohort. |
| 12 | `0` | `null` | `null` | OK | — | IPv4 octet. |
| 13 | `4` | `null` | `null` | OK | — | IPv4 octet. |
| 14 | `27` | `null` | `null` | OK | — | IPv4 octet. |
| 15 | `wazuh-mgr` | `manager.name` | `manager.name` | OK | json_key | Nested under manager. |
| 16 | `1748278342.421421` | `id` | `id` | OK | json_key | Top-level id key — sibling test, must NOT pick agent.id or rule.id. |
| 17 | `May 26 14:32:18 web-01 sshd[18` | `full_log` | `full_log` | OK | json_key | Top-level full_log. |
| 18 | `sshd` | `predecoder.program_name` | `predecoder.program_name` | OK | json_key | Nested under predecoder. |
| 19 | `May 26 14:32:18` | `predecoder.timestamp` | `predecoder.timestamp` | OK | json_key | Nested under predecoder. |
| 20 | `web-01` | `predecoder.hostname` | `predecoder.hostname` | OK | json_key | Nested under predecoder. |
| 21 | `sshd` | `decoder.parent` | `decoder.parent` | OK | json_key | Nested under decoder. |
| 22 | `sshd` | `decoder.name` | `decoder.name` | OK | json_key | Nested under decoder — sibling test, must NOT pick decoder.parent. |
| 23 | `203` | `null` | `data.srcip` | false_positive | json_key | IPv4 octet of data.srcip — cohort. |
| 24 | `0` | `null` | `null` | OK | — | IPv4 octet. |
| 25 | `113` | `null` | `null` | OK | — | IPv4 octet. |
| 26 | `42` | `null` | `null` | OK | — | IPv4 octet. |
| 27 | `51234` | `data.srcport` | `data.srcport` | OK | json_key | Nested under data. |
| 28 | `admin` | `data.srcuser` | `data.srcuser` | OK | json_key | Nested under data. |
| 29 | `/var/log/auth.log` | `location` | `location` | OK | json_key | Top-level location. |

Cohorts:
  - OK: ipv4 cohort `agent.ip` covers ["slot_11","slot_12","slot_13","slot_14"]
  - OK: ipv4 cohort `data.srcip` covers ["slot_23","slot_24","slot_25","slot_26"]

### `ossec-text-alert` — OSSEC text alert format (alerts.log) (security/ossec)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `1748278342.421421` | `alert_id` | `null` | miss_no_name | — | Token after '** Alert ' and before ':'. |
| 1 | `syslog,sshd,authentication_fai` | `groups` | `null` | miss_no_name | — | Comma list after 'mail - '. |
| 2 | `2026 May 26 14:32:18` | `timestamp` | `timestamp` | OK | format_spec | Datetime stamp before the parenthesized agent. |
| 3 | `web-01` | `agent_name` | `null` | miss_no_name | — | Parenthesized agent name. |
| 4 | `10` | `null` | `null` | OK | — | IPv4 octet — cohort agent_ip. |
| 5 | `0` | `null` | `null` | OK | — | IPv4 octet. |
| 6 | `4` | `null` | `null` | OK | — | IPv4 octet. |
| 7 | `27` | `null` | `null` | OK | — | IPv4 octet. |
| 8 | `/var/log/auth.log` | `location` | `null` | miss_no_name | — | Token after '->' (the log source path). |
| 9 | `5712` | `rule_id` | `rule` | miss_wrong_name | kv_pair | Token after 'Rule: '. |
| 10 | `10` | `rule_level` | `level` | miss_wrong_name | noun_prefix | Token after '(level '. |
| 11 | `sshd: brute force trying to ge` | `rule_description` | `null` | miss_no_name | — | Quoted text after '-> '. Inner colon inside the quoted phrase must NOT be parsed |
| 12 | `203` | `null` | `ip` | false_positive | kv_pair | IPv4 octet — cohort src_ip. |
| 13 | `0` | `null` | `null` | OK | — | IPv4 octet. |
| 14 | `113` | `null` | `null` | OK | — | IPv4 octet. |
| 15 | `42` | `null` | `null` | OK | — | IPv4 octet. |
| 16 | `51234` | `src_port` | `port` | miss_wrong_name | kv_pair | Token after 'Src Port: '. |
| 17 | `admin` | `user` | `user` | OK | kv_pair | Token after 'User: '. |
| 18 | `May 26 14:32:18 web-01 sshd[18` | `full_log` | `null` | miss_no_name | — | Trailing raw log line. |

Cohorts:
  - PARTIAL: ipv4 cohort detected with right members, but name mismatch — expected `agent_ip`, got `ipv4`
  - PARTIAL: ipv4 cohort detected with right members, but name mismatch — expected `src_ip`, got `ipv4`

### `otel-resource-instance-and-mac` — OTel-style structured log emitting host MAC + service.instance.id (k8s/container)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `checkout` | `resource.attributes.service.name` | `resource.attributes.service.name` | OK | json_key | Deeply nested OTel resource attribute — dotted key preserved verbatim. |
| 1 | `7af19b32` | `null` | `resource.attributes.service.instance.id` | false_positive | json_key | UUID segment of service.instance.id — cohort. |
| 2 | `c0a2` | `null` | `null` | OK | — | UUID segment. |
| 3 | `4f33` | `null` | `null` | OK | — | UUID segment. |
| 4 | `8e3d` | `null` | `null` | OK | — | UUID segment. |
| 5 | `1cb5d3a0c0c1` | `null` | `null` | OK | — | UUID segment. |
| 6 | `02` | `null` | `resource.attributes.host.mac` | false_positive | json_key | MAC octet — cohort host.mac. |
| 7 | `42` | `null` | `null` | OK | — | MAC octet. |
| 8 | `ac` | `null` | `null` | OK | — | MAC octet. |
| 9 | `11` | `null` | `null` | OK | — | MAC octet. |
| 10 | `00` | `null` | `null` | OK | — | MAC octet. |
| 11 | `0a` | `null` | `null` | OK | — | MAC octet. |
| 12 | `10` | `null` | `resource.attributes.host.ip` | false_positive | json_key | IPv4 octet — cohort host.ip. |
| 13 | `0` | `null` | `null` | OK | — | IPv4 octet. |
| 14 | `4` | `null` | `null` | OK | — | IPv4 octet. |
| 15 | `27` | `null` | `null` | OK | — | IPv4 octet. |
| 16 | `started` | `body` | `body` | OK | json_key | Top-level body. |
| 17 | `INFO` | `severity_text` | `severity_text` | OK | json_key | Top-level severity_text. |
| 18 | `2026-05-26T14:32:18.421421Z` | `timestamp` | `timestamp` | OK | json_key | Top-level timestamp. |

Cohorts:
  - OK: uuid cohort `resource.attributes.service.instance.id` covers ["slot_1","slot_2","slot_3","slot_4","slot_5"]
  - OK: mac cohort `resource.attributes.host.mac` covers ["slot_6","slot_7","slot_8","slot_9","slot_10","slot_11"]
  - OK: ipv4 cohort `resource.attributes.host.ip` covers ["slot_12","slot_13","slot_14","slot_15"]

### `node-pino-backref-duration` — Node service emitting duration with engine back-reference (app/node)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `30` | `level` | `level` | OK | json_key | JSON key level. |
| 1 | `1748278342901` | `time` | `time` | OK | json_key | JSON key time. |
| 2 | `slow query` | `msg` | `msg` | OK | json_key | JSON key msg. |
| 3 | `1.234` | `duration` | `duration` | OK | json_key | JSON key duration. |
| 4 | `SELECT * FROM users` | `query` | `query` | OK | json_key | JSON key query. |
| 5 | `1` | `durationStr` | `durationStr_part2` | miss_wrong_name | json_key_composite | Back-reference slot `$3` reuses the value of slot 3 (duration), inserted as the  |

### `nginx-access-combined-01` — nginx access log (combined format) (infra/web-server)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `93.184.216.34` | `remote_addr` | `null` | miss_no_name | — | Leading token before first hyphen is client IP in combined format. |
| 1 | `-` | `null` | `null` | OK | — | Remote user placeholder with no semantic value when absent. |
| 2 | `22/Jan/2023:12:34:56 +0000` | `time_local` | `null` | miss_no_name | — | Bracketed timestamp immediately after remote user. |
| 3 | `GET` | `request_method` | `null` | miss_no_name | — | First token inside quoted request line. |
| 4 | `/api/v1/users` | `request_uri` | `null` | miss_no_name | — | URI portion of the HTTP request line. |
| 5 | `HTTP/1.1` | `server_protocol` | `null` | miss_no_name | — | Protocol token completing the request triple. |
| 6 | `200` | `status` | `null` | miss_no_name | — | Numeric status immediately after closing request quote. |
| 7 | `512` | `body_bytes_sent` | `null` | miss_no_name | — | Byte count following status code. |
| 8 | `https://example.com` | `http_referer` | `null` | miss_no_name | — | Quoted referrer field. |

### `envoy-access-01` — Envoy access log (infra/load-balancer)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `2023-01-22T12:34:56.789Z` | `timestamp` | `timestamp` | OK | format_spec | ISO timestamp inside square brackets at log start. |
| 1 | `GET` | `request_method` | `null` | miss_no_name | — | HTTP method inside quoted request triple. |
| 2 | `/health` | `request_uri` | `null` | miss_no_name | — | Path component of request line. |
| 3 | `HTTP/1.1` | `server_protocol` | `null` | miss_no_name | — | Protocol completing request line. |
| 4 | `200` | `response_code` | `null` | miss_no_name | — | HTTP status code after request triple. |
| 5 | `0` | `response_flags` | `null` | miss_no_name | — | Envoy response flags field. |
| 6 | `123` | `bytes_received` | `null` | miss_no_name | — | Bytes received field per Envoy format. |
| 7 | `45` | `duration` | `null` | miss_no_name | — | Request duration in ms. |
| 8 | `67` | `upstream_duration` | `null` | miss_no_name | — | Upstream service duration. |
| 9 | `curl/7.68.0` | `user_agent` | `null` | miss_no_name | — | Quoted user-agent value. |
| 10 | `10.1.2.3:443` | `downstream_address` | `null` | miss_no_name | — | Downstream remote address:port. |
| 11 | `10.4.5.6:80` | `upstream_address` | `null` | miss_no_name | — | Upstream local address:port. |

### `rfc3164-sshd-01` — RFC3164 sshd auth event (os/syslog)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `Jan` | `month` | `null` | miss_no_name | — | Syslog timestamp month token. |
| 1 | `22` | `day` | `null` | miss_no_name | — | Syslog day of month. |
| 2 | `12:34:56` | `time` | `null` | miss_no_name | — | Syslog time of day. |
| 3 | `host-01` | `hostname` | `null` | miss_no_name | — | Origin hostname per RFC3164. |
| 4 | `1234` | `pid` | `null` | miss_no_name | — | sshd process id inside brackets. |
| 5 | `alice` | `user` | `null` | miss_no_name | — | Username following 'for' in auth failure. |
| 6 | `192.168.10.20` | `client_ip` | `null` | miss_no_name | — | Source IP after 'from' keyword. |
| 7 | `55231` | `client_port` | `port` | miss_wrong_name | noun_prefix | TCP port after IP address. |

### `windows-security-4624-01` — Windows Security Event Log 4624 (os/windows)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `1/22/2023` | `date` | `null` | miss_no_name | — | Event date at start of rendered line. |
| 1 | `12:34:56` | `time` | `null` | miss_no_name | — | Event time token. |
| 2 | `PM` | `ampm` | `null` | miss_no_name | — | AM/PM indicator. |
| 3 | `10.0.0.5` | `ip_address` | `null` | miss_no_name | — | Workstation IP in 4624 logon event. |
| 4 | `S-1-5-18` | `security_id` | `null` | miss_no_name | — | SID of account that logged on. |
| 5 | `SYSTEM` | `account_name` | `null` | miss_no_name | — | Account name field after SID. |
| 6 | `WORKSTATION01$` | `workstation_name` | `null` | miss_no_name | — | Calling workstation name. |
| 7 | `NT AUTHORITY` | `logon_domain` | `null` | miss_no_name | — | Logon domain preceding final account name. |
| 8 | `SYSTEM` | `logon_account` | `null` | miss_no_name | — | Final account name in event. |
| 9 | `3` | `logon_type` | `null` | miss_no_name | — | Numeric logon type code at end of line. |
| 10 | `` | `null` | `null` | OK | — |  |
| 11 | `` | `null` | `null` | OK | — |  |

### `iptables-log-01` — iptables LOG target with prefix (firewall)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `Jan` | `month` | `null` | miss_no_name | — | Syslog date month. |
| 1 | `22` | `day` | `null` | miss_no_name | — | Syslog day. |
| 2 | `12:34:56` | `time` | `null` | miss_no_name | — | Syslog time. |
| 3 | `host` | `hostname` | `null` | miss_no_name | — | Origin host. |
| 4 | `eth0` | `in_interface` | `null` | miss_no_name | — | IN= interface name after prefix. |
| 5 | `00:11:22:33:44:55:66:77:88:99:` | `mac` | `mac` | OK | kv_pair | MAC address after MAC= tag. |
| 6 | `10.0.0.5` | `src_ip` | `src` | miss_wrong_name | kv_pair | SRC= value. |
| 7 | `10.0.0.1` | `dst_ip` | `dst` | miss_wrong_name | kv_pair | DST= value. |
| 8 | `60` | `len` | `len` | OK | kv_pair | Packet length after LEN=. |
| 9 | `0x00` | `tos` | `tos` | OK | kv_pair | TOS field. |
| 10 | `0x00` | `prec` | `prec` | OK | kv_pair | PREC field. |
| 11 | `63` | `ttl` | `ttl` | OK | kv_pair | TTL value. |
| 12 | `12345` | `id` | `id` | OK | kv_pair | IP ID field. |
| 13 | `TCP` | `protocol` | `proto` | miss_wrong_name | kv_pair | PROTO= value. |
| 14 | `54321` | `src_port` | `spt` | miss_wrong_name | kv_pair | SPT= source port. |
| 15 | `22` | `dst_port` | `dpt` | miss_wrong_name | kv_pair | DPT= destination port. |
| 16 | `65535` | `window` | `window` | OK | kv_pair | TCP WINDOW size. |
| 17 | `0x00` | `res` | `res` | OK | kv_pair | RES flags. |
| 18 | `0` | `urgp` | `urgp` | OK | kv_pair | URGP value at end. |

Cohorts:
  - MISS: expected mac cohort at [5] named `mac` — not detected

### `mysql-slow-query-01` — MySQL slow query log (database/mysql)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `2023-01-22T12:34:56.789000Z` | `time` | `time` | OK | kv_pair | ISO timestamp after Time: marker. |
| 1 | `appuser` | `user` | `null` | miss_no_name | — | Username before bracketed user again. |
| 2 | `appuser` | `user` | `null` | miss_no_name | — | Repeated username inside brackets. |
| 3 | `dbhost` | `host` | `null` | miss_no_name | — | Host after @ symbol. |
| 4 | `10.2.3.4` | `client_ip` | `null` | miss_no_name | — | Client IP inside square brackets. |
| 5 | `987` | `id` | `id` | OK | kv_pair | Connection Id value. |
| 6 | `4.567890` | `query_time` | `query_time` | OK | kv_pair | Query_time floating point value. |
| 7 | `0.001234` | `lock_time` | `lock_time` | OK | kv_pair | Lock_time value. |
| 8 | `42` | `rows_sent` | `rows_sent` | OK | kv_pair | Rows_sent count. |
| 9 | `1000000` | `rows_examined` | `rows_examined` | OK | kv_pair | Rows_examined count. |
| 10 | `1674381296` | `unix_timestamp` | `timestamp` | miss_wrong_name | kv_pair | Unix timestamp after SET timestamp=. |
| 11 | `SELECT * FROM orders WHERE cus` | `query` | `null` | miss_no_name | — | Actual SQL statement at end of entry. |

### `postgres-logline-01` — PostgreSQL log with log_line_prefix (database/postgres)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `2023-01-22` | `date` | `null` | miss_no_name | — | Date portion of %t prefix. |
| 1 | `12:34:56.789` | `time` | `null` | miss_no_name | — | Time portion of %t prefix. |
| 2 | `UTC` | `timezone` | `null` | miss_no_name | — | Timezone token after time. |
| 3 | `1234` | `pid` | `null` | miss_no_name | — | Process ID inside brackets per %p. |
| 4 | `alice` | `user` | `null` | miss_no_name | — | Username before @ in %u@%d. |
| 5 | `mydb` | `database` | `null` | miss_no_name | — | Database name after @. |
| 6 | `12.345` | `duration` | `null` | miss_no_name | — | Duration value after 'duration:'. |
| 7 | `SELECT * FROM users WHERE id =` | `statement` | `duration` | miss_wrong_name | kv_pair | SQL statement after 'statement:'. |
| 8 | `` | `null` | `statement` | false_positive | kv_pair |  |

### `aws-cloudtrail-01` — AWS CloudTrail JSON event (cloud/aws)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `1.08` | `event_version` | `eventVersion` | miss_wrong_name | json_key | Top-level eventVersion value. |
| 1 | `a1b2c3d4-e5f6-7890-abcd-ef1234` | `event_id` | `eventID` | miss_wrong_name | json_key | Top-level eventID value. |
| 2 | `IAMUser` | `user_identity.type` | `userIdentity.type` | miss_wrong_name | json_key | Nested userIdentity.type value. |
| 3 | `alice` | `user_identity.user_name` | `userIdentity.userName` | miss_wrong_name | json_key | Nested userIdentity.userName value. |
| 4 | `arn:aws:iam::123456789012:user` | `user_identity.arn` | `userIdentity.arn` | miss_wrong_name | json_key | Nested userIdentity.arn value. |
| 5 | `s3.amazonaws.com` | `event_source` | `eventSource` | miss_wrong_name | json_key | Top-level eventSource value. |
| 6 | `GetObject` | `event_name` | `eventName` | miss_wrong_name | json_key | Top-level eventName value. |

### `aws-vpcflow-v2-01` — AWS VPC Flow Log v2 (cloud/aws)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `2` | `version` | `null` | miss_no_name | — | Flow log version number. |
| 1 | `123456789012` | `account_id` | `null` | miss_no_name | — | AWS account ID. |
| 2 | `eni-0a1b2c3d4e5f67890` | `interface_id` | `null` | miss_no_name | — | ENI identifier. |
| 3 | `10.0.1.5` | `srcaddr` | `null` | miss_no_name | — | Source IP address. |
| 4 | `10.0.2.7` | `dstaddr` | `null` | miss_no_name | — | Destination IP address. |
| 5 | `443` | `srcport` | `null` | miss_no_name | — | Source port. |
| 6 | `54321` | `dstport` | `null` | miss_no_name | — | Destination port. |
| 7 | `6` | `protocol` | `null` | miss_no_name | — | IP protocol number. |
| 8 | `12` | `packets` | `null` | miss_no_name | — | Packet count. |
| 9 | `8400` | `bytes` | `null` | miss_no_name | — | Byte count. |
| 10 | `1674381296` | `start` | `null` | miss_no_name | — | Start time Unix epoch. |
| 11 | `1674381301` | `end` | `null` | miss_no_name | — | End time Unix epoch. |
| 12 | `ACCEPT` | `action` | `null` | miss_no_name | — | Traffic action. |
| 13 | `OK` | `log_status` | `null` | miss_no_name | — | Log status field. |

### `k8s-audit-json-01` — Kubernetes apiserver audit log (k8s/audit)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `2023-01-22T12:34:56.789Z` | `request_received_timestamp` | `requestReceivedTimestamp` | miss_wrong_name | json_key | Audit timestamp field. |
| 1 | `get` | `verb` | `verb` | OK | json_key | API verb performed. |
| 2 | `system:serviceaccount:kube-sys` | `user.username` | `user.username` | OK | json_key | Nested user username. |
| 3 | `pods` | `object_ref.resource` | `objectRef.resource` | miss_wrong_name | json_key | objectRef.resource value. |
| 4 | `default` | `object_ref.namespace` | `objectRef.namespace` | miss_wrong_name | json_key | objectRef.namespace value. |
| 5 | `mypod` | `object_ref.name` | `objectRef.name` | miss_wrong_name | json_key | objectRef.name value. |
| 6 | `200` | `response_status.code` | `responseStatus.code` | miss_wrong_name | json_key | HTTP response code inside responseStatus. |

### `java-springboot-json-01` — Spring Boot JSON log (app/java)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `2023-01-22T12:34:56.789Z` | `timestamp` | `@timestamp` | miss_wrong_name | json_key | Standard @timestamp field. |
| 1 | `INFO` | `level` | `level` | OK | json_key | Log level value. |
| 2 | `http-nio-8080-exec-1` | `thread` | `thread` | OK | json_key | Thread name field. |
| 3 | `com.example.UserService` | `logger` | `logger` | OK | json_key | Logger class name. |
| 4 | `98765` | `user_id` | `id` | miss_wrong_name | noun_prefix | User id extracted from message text. |
| 5 | `svc-01` | `service.instance.id` | `service.instance.id` | OK | json_key | OTel style dotted key at end of JSON. |

### `falco-event-01` — Falco security event (security/falco)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `10:34:56.789000000` | `timestamp` | `output` | miss_wrong_name | json_key | Timestamp inside output string. |
| 1 | `root` | `user` | `user` | OK | kv_pair | User inside parenthetical output. |
| 2 | `bash` | `shell` | `shell` | OK | kv_pair | Shell binary inside output. |
| 3 | `abc123` | `container_id` | `container_id` | OK | kv_pair | container_id value inside output. |
| 4 | `Notice` | `priority` | `priority` | OK | json_key | Priority field outside output. |
| 5 | `abc123` | `output_fields.container.id` | `output_fields.container.id` | OK | json_key | Nested output_fields.container.id value. |
| 6 | `root` | `output_fields.user.name` | `output_fields.user.name` | OK | json_key | Nested output_fields.user.name value. |

### `python-json-log-01` — Python structlog JSON (app/python)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `request_finished` | `event` | `event` | OK | json_key | Top level event name. |
| 1 | `2023-01-22T12:34:56.789Z` | `timestamp` | `timestamp` | OK | json_key | Timestamp field. |
| 2 | `req-abc-123` | `request_id` | `request_id` | OK | json_key | request_id value. |
| 3 | `POST` | `method` | `method` | OK | json_key | HTTP method value. |
| 4 | `/api/orders` | `path` | `path` | OK | json_key | Request path value. |
| 5 | `201` | `status_code` | `status_code` | OK | json_key | HTTP status_code value. |
| 6 | `87.3` | `duration_ms` | `duration_ms` | OK | json_key | duration_ms floating value. |

### `go-otel-log-01` — Go application with OTel logging (app/go)

| pos | value | expected | algo | match | source | reasoning |
|---|---|---|---|---|---|---|
| 0 | `info` | `severity` | `severity` | OK | json_key | severity level field. |
| 1 | `order processed` | `body` | `body` | OK | json_key | Log body message. |
| 2 | `order-svc-7b9f4c2` | `resource.service.instance.id` | `resource.service.instance.id` | OK | json_key | OTel dotted resource attribute. |
| 3 | `4bf92f3577b34da6a3ce929d0e0e47` | `trace_id` | `trace_id` | OK | json_key | W3C trace_id value. |
| 4 | `00f067aa0ba902b7` | `span_id` | `span_id` | OK | json_key | span_id value. |
| 5 | `ord-98765` | `attributes.order.id` | `attributes.order.id` | OK | json_key | Nested attributes.order.id value. |

