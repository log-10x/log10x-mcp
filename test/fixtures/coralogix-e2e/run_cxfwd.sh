#!/bin/bash
# Launch the cxfwd app on the JVM run-cloud classpath.
# $1 = stdout log path
set -u
CX=/private/tmp/claude-501/-Users-talweiss-eclipse-workspace-l1x-co-config/377b216b-e7aa-484d-8d7b-0260f807184f/scratchpad/cx
export TENX_HOME=/Users/talweiss/eclipse-workspace/l1x-co/config
export TENX_SYMBOLS_PATH=/usr/local/etc/tenx/symbols
export apiKey="${TENX_API_KEY:?export TENX_API_KEY first (never hardcode: this file is public)}"
export TENX_LICENSE="${TENX_LICENSE:?export TENX_LICENSE first (never hardcode: this file is public)}"
export CAP_LOOKUP_FILE=$CX/caps.csv
export ACTION_LOOKUP_FILE=$CX/actions.csv
export outputOffload=true

# capLookup.retain is 10m; a stale caps file is silently ignored (one INFO
# line) and every event comes back `pass`.
touch "$CAP_LOOKUP_FILE" "$ACTION_LOOKUP_FILE"

cd "$TENX_HOME" || exit 1
exec /Library/Java/JavaVirtualMachines/jdk-23.jdk/Contents/Home/bin/java -Xmx520M \
  -Dtenx.io.tmpdir=$TENX_HOME/config/data/fetch \
  -DTENX_LICENSE_FILE=/Users/talweiss/.tenx/demo-license.jwt -Dfile.encoding=UTF-8 \
  -classpath "$(cat /Users/talweiss/run-cloud.classpath)" \
  com.log10x.ext.cloud.run.RunCloud \
  overrideKey groupFlushTimeout overrideValue '$=parseDuration("200ms")' \
  "$@" \
  @apps/cxfwd
