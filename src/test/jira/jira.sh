#!/usr/bin/env bash
#
# A throwaway standalone Jira or Confluence (Atlassian Plugin SDK, atlas-run-standalone) for the real-product checks
# of the REST API Browser. See src/test/jira/README.md.
#
#   src/test/jira/jira.sh start    start in the background, return when it answers (first start: a 0.5-1 GB download
#                                  plus a few minutes of setup; later starts about 2 minutes)
#   src/test/jira/jira.sh run      the same in the foreground (blocks until it stops)
#   src/test/jira/jira.sh wait     wait until an instance started elsewhere answers
#   src/test/jira/jira.sh status   print whether it answers, its version and the work directory
#   src/test/jira/jira.sh stop     stop it (graceful through AMPS, then by the PID listening on the port)
#
# Settings (environment, or src/test/jira/local.env, which this script sources when present and git ignores):
#   RAB_PRODUCT     jira or confluence                (default jira; confluence: the same for Confluence, with its
#                                                     own defaults below, at http://localhost:1992/confluence)
#   JIRA_VERSION    product version                   (default 11.3.13; Confluence 10.2.20)
#   JIRA_HTTP_PORT  HTTP port                         (default 2992, next to the SDK's usual 2990; Confluence 1992)
#   JIRA_AJP_PORT   AJP port                          (default 8020; Confluence 8022)
#   JIRA_WORKDIR    AMPS work directory (product home) (default $HOME/$RAB_PRODUCT-rab-$JIRA_VERSION-$JIRA_HTTP_PORT)
#   JIRA_SDK_HOME   Atlassian Plugin SDK, 9.11+       (default: atlas-run-standalone on the PATH; ATLAS_HOME is not
#                                                     used, so an older SDK there is not picked up by accident)
#   JIRA_JAVA_HOME  JDK that runs AMPS and the product (default $JAVA_HOME; Jira 11 runs on Java 21 only)
#   JIRA_DEV_MODE   true or false                     (default true, as the SDK; false: the page loads the bundle
#                                                     rest-api-browser.min.js, as in a product outside dev mode)
#   JIRA_START_TIMEOUT  seconds to wait for it        (default 1800, the first start downloads the WAR)
#
# The product is reachable at http://localhost:$JIRA_HTTP_PORT/$RAB_PRODUCT with admin/admin. Delete the work
# directory to start again from a fresh one. Never point the checks at a shared or production instance: they install
# and remove plugins.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# machine-specific settings (SDK and JDK paths), kept out of git
[ -f "$SCRIPT_DIR/local.env" ] && . "$SCRIPT_DIR/local.env"

die() { echo "jira.sh: $*" >&2; exit 2; }

RAB_PRODUCT="${RAB_PRODUCT:-jira}"
case "$RAB_PRODUCT" in
    jira) PRODUCT_NAME=Jira; DEFAULT_VERSION=11.3.13; DEFAULT_HTTP_PORT=2992; DEFAULT_AJP_PORT=8020 ;;
    confluence) PRODUCT_NAME=Confluence; DEFAULT_VERSION=10.2.20; DEFAULT_HTTP_PORT=1992; DEFAULT_AJP_PORT=8022 ;;
    *) die "RAB_PRODUCT is jira or confluence, not $RAB_PRODUCT" ;;
esac
JIRA_VERSION="${JIRA_VERSION:-$DEFAULT_VERSION}"
JIRA_HTTP_PORT="${JIRA_HTTP_PORT:-$DEFAULT_HTTP_PORT}"
JIRA_AJP_PORT="${JIRA_AJP_PORT:-$DEFAULT_AJP_PORT}"
JIRA_WORKDIR="${JIRA_WORKDIR:-$HOME/$RAB_PRODUCT-rab-$JIRA_VERSION-$JIRA_HTTP_PORT}"
JIRA_SDK_HOME="${JIRA_SDK_HOME:-}"
JIRA_JAVA_HOME="${JIRA_JAVA_HOME:-${JAVA_HOME:-}}"
JIRA_START_TIMEOUT="${JIRA_START_TIMEOUT:-1800}"
JIRA_DEV_MODE="${JIRA_DEV_MODE:-true}"

BASE_URL="http://localhost:$JIRA_HTTP_PORT/$RAB_PRODUCT"
LOG="$JIRA_WORKDIR/run.log"
TAIL_PID_FILE="$JIRA_WORKDIR/stdin-holder.pid"

atlas_cmd() {
    # Git Bash does not resolve atlas-run-standalone without .bat, and a .bat has no executable bit there
    if [ -n "$JIRA_SDK_HOME" ]; then
        if [ -f "$JIRA_SDK_HOME/bin/atlas-run-standalone.bat" ]; then echo "$JIRA_SDK_HOME/bin/atlas-run-standalone.bat"
        elif [ -x "$JIRA_SDK_HOME/bin/atlas-run-standalone" ]; then echo "$JIRA_SDK_HOME/bin/atlas-run-standalone"
        else die "no atlas-run-standalone in $JIRA_SDK_HOME/bin (set JIRA_SDK_HOME to the Plugin SDK, 9.11 or newer)"
        fi
    elif command -v atlas-run-standalone.bat >/dev/null 2>&1; then command -v atlas-run-standalone.bat
    elif command -v atlas-run-standalone >/dev/null 2>&1; then command -v atlas-run-standalone
    else die "no atlas-run-standalone on the PATH (set JIRA_SDK_HOME to the Plugin SDK, 9.11 or newer)"
    fi
}

# PID (Windows or Unix) of the process listening on the HTTP port, empty when none
listener_pid() {
    if command -v netstat >/dev/null 2>&1 && netstat -ano >/dev/null 2>&1; then
        netstat -ano | awk -v p=":$JIRA_HTTP_PORT" '$2 ~ p"$" && ($4 == "LISTENING" || $4 == "LISTEN") {print $5; exit}'
    elif command -v lsof >/dev/null 2>&1; then
        lsof -t -iTCP:"$JIRA_HTTP_PORT" -sTCP:LISTEN 2>/dev/null | head -1
    fi
}

# the product's state from /status: RUNNING, STARTING, ... or empty when it does not answer
jira_state() {
    curl -s -m 5 "$BASE_URL/status" 2>/dev/null | sed -n 's/.*"state" *: *"\([A-Z_]*\)".*/\1/p'
}

# the version from the application links manifest, which Jira and Confluence serve anonymously (Jira 11 refuses an
# anonymous serverInfo)
jira_version() {
    curl -s -m 5 -H 'Accept: application/json' "$BASE_URL/rest/applinks/1.0/manifest" 2>/dev/null \
        | sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p'
}

# The REST API Browser builds the WADL URLs of its page from the base URL, so with another base URL the page would load
# them from another instance (or none). AMPS's Jira test data has the base URL http://localhost:2990/jira whatever the
# port; Confluence gets http://<AMPS's server>:<port>/confluence, and launch passes --server localhost.
fix_base_url() {
    local auth="${JIRA_USER:-admin}:${JIRA_PASSWORD:-admin}" cur code
    cur="$(curl -s -m 10 -H 'Accept: application/json' "$BASE_URL/rest/applinks/1.0/manifest" \
        | sed -n 's/.*"url" *: *"\([^"]*\)".*/\1/p')"
    [ -z "$cur" ] || [ "$cur" = "$BASE_URL" ] && return 0
    if [ "$RAB_PRODUCT" != jira ]; then
        echo "jira.sh: $PRODUCT_NAME's base URL is $cur, not $BASE_URL; set it in General Configuration" >&2
        return 1
    fi
    code="$(curl -s -o /dev/null -w '%{http_code}' -m 30 -u "$auth" -X PUT -H 'Content-Type: application/json' \
        -H 'X-Atlassian-Token: no-check' --data "$BASE_URL" "$BASE_URL/rest/api/2/settings/baseUrl")"
    if [ "$code" = "200" ] || [ "$code" = "204" ]; then
        echo "Jira's base URL was $cur: set it to $BASE_URL"
    else
        echo "jira.sh: could not set Jira's base URL to $BASE_URL (HTTP $code); set it in Administration > System" >&2
        return 1
    fi
}

wait_ready() {
    local deadline=$(( $(date +%s) + JIRA_START_TIMEOUT )) last=""
    echo "Waiting for $BASE_URL (up to ${JIRA_START_TIMEOUT}s; log: $LOG)"
    while [ "$(date +%s)" -lt "$deadline" ]; do
        if [ "$(jira_state)" = "RUNNING" ] && [ -n "$(jira_version)" ]; then
            fix_base_url || return 1
            echo "$PRODUCT_NAME $(jira_version) is up at $BASE_URL (admin/admin)"
            return 0
        fi
        if [ -f "$LOG" ] && grep -q -E "BUILD FAILURE|\[ERROR\] Failed to execute goal" "$LOG"; then
            echo "jira.sh: AMPS failed; the end of $LOG:" >&2
            tail -40 "$LOG" >&2
            return 1
        fi
        # one progress line per minute: the newest AMPS line (-a: Confluence's output makes grep see a binary file)
        if [ -f "$LOG" ] && [ $(( $(date +%s) % 60 )) -lt 5 ]; then
            local now
            now="$(grep -a -E '^\[INFO\]' "$LOG" | tail -1 | cut -c1-150)"
            [ "$now" != "$last" ] && echo "  ... $now" && last="$now"
        fi
        sleep 5
    done
    echo "jira.sh: $PRODUCT_NAME did not answer within ${JIRA_START_TIMEOUT}s; the end of $LOG:" >&2
    tail -40 "$LOG" >&2
    return 1
}

check_free() {
    local pid
    pid="$(listener_pid)"
    if [ -n "$pid" ]; then
        local v
        v="$(jira_version)"
        if [ "$v" = "$JIRA_VERSION" ]; then
            echo "$PRODUCT_NAME $v already runs at $BASE_URL (PID $pid)"
            exit 0
        fi
        die "port $JIRA_HTTP_PORT is taken by PID $pid ($PRODUCT_NAME version: ${v:-none}); stop it or set JIRA_HTTP_PORT"
    fi
}

launch() {
    # $1 = "bg" or "fg"
    local atlas
    atlas="$(atlas_cmd)" || exit 2
    [ -n "$JIRA_JAVA_HOME" ] || die "no JDK: set JIRA_JAVA_HOME (or JAVA_HOME) to a JDK 21"
    [ -x "$JIRA_JAVA_HOME/bin/java" ] || [ -x "$JIRA_JAVA_HOME/bin/java.exe" ] || die "no JDK at $JIRA_JAVA_HOME (set JIRA_JAVA_HOME)"
    local java_version
    java_version="$("$JIRA_JAVA_HOME/bin/java" -version 2>&1 | head -1)"
    case "$RAB_PRODUCT:$JIRA_VERSION:$java_version" in
        jira:11.*:*'"21'*) ;;
        jira:11.*:*) echo "jira.sh: warning: Jira 11 runs on Java 21 only, not $java_version (set JIRA_JAVA_HOME)" >&2 ;;
    esac
    mkdir -p "$JIRA_WORKDIR"
    cd "$JIRA_WORKDIR" || die "cannot enter $JIRA_WORKDIR"
    rm -f "$TAIL_PID_FILE"
    export JAVA_HOME="$JIRA_JAVA_HOME"
    export PATH="$JIRA_JAVA_HOME/bin:$PATH"
    # AMPS starts the product in dev mode unless atlassian.dev.mode is already a system property of the Maven JVM. The SDK's
    # launcher replaces MAVEN_OPTS with "-Xms512M -Xmx768M $ATLAS_OPTS", so the property goes into ATLAS_OPTS.
    # Outside dev mode UPM refuses uploads unless the product runs with -Dupm.plugin.upload.enabled=true: it goes in as
    # AMPS's jvmargs property (the SDK's --jvmargs would split it at "=" on Windows); AMPS keeps its -Xmx/-Xms defaults.
    [ "$JIRA_DEV_MODE" = "false" ] &&
        export ATLAS_OPTS="${ATLAS_OPTS:+$ATLAS_OPTS }-Datlassian.dev.mode=false -Djvmargs=-Dupm.plugin.upload.enabled=true"
    echo "Starting $PRODUCT_NAME $JIRA_VERSION on port $JIRA_HTTP_PORT in $JIRA_WORKDIR with $java_version, dev mode $JIRA_DEV_MODE"
    local cmd=( "$atlas" --product "$RAB_PRODUCT" --version "$JIRA_VERSION" --http-port "$JIRA_HTTP_PORT" --ajp-port "$JIRA_AJP_PORT" )
    # AMPS's server defaults to the host name, which goes into Confluence's base URL (see fix_base_url)
    [ "$RAB_PRODUCT" = confluence ] && cmd+=( --server localhost )
    if [ "$1" = "fg" ]; then
        run_amps "${cmd[@]}" 2>&1 | tee "$LOG"
    else
        ( run_amps "${cmd[@]}" > "$LOG" 2>&1 & )
        sleep 2
        wait_ready
    fi
}

# AMPS waits on stdin once Jira is up and shuts Jira down on EOF. A tail keeps stdin open, and killing it (jira.sh
# stop) is the graceful stop; its PID goes to a file. The tail never writes, so it would outlive a failed AMPS
# forever: it is killed as soon as AMPS exits. Each run kills only its own tail (its PID also goes to a file of the
# run): after "jira.sh stop" the old AMPS can exit after a new start has already written the shared file.
run_amps() {
    local own="$TAIL_PID_FILE.$BASHPID" rc i holder
    "$@" < <(echo "$BASHPID" > "$own"; echo "$BASHPID" > "$TAIL_PID_FILE"; exec tail -f /dev/null)
    rc=$?
    for i in 1 2 3 4 5 6 7 8 9 10; do [ -s "$own" ] && break; sleep 0.5; done
    holder="$(cat "$own" 2>/dev/null)"
    if [ -n "$holder" ]; then
        kill "$holder" 2>/dev/null
        [ "$(cat "$TAIL_PID_FILE" 2>/dev/null)" = "$holder" ] && rm -f "$TAIL_PID_FILE"
    fi
    rm -f "$own"
    return $rc
}

stop_holder() {
    [ -f "$TAIL_PID_FILE" ] || return 1
    kill "$(cat "$TAIL_PID_FILE")" 2>/dev/null
    local rc=$?
    rm -f "$TAIL_PID_FILE"
    return $rc
}

stop() {
    local pid
    pid="$(listener_pid)"
    stop_holder && echo "Closed AMPS's stdin: $PRODUCT_NAME shuts down"
    if [ -n "$pid" ]; then
        local i
        for i in $(seq 1 24); do
            [ -z "$(listener_pid)" ] && break
            sleep 5
        done
        pid="$(listener_pid)"
        if [ -n "$pid" ]; then
            echo "$PRODUCT_NAME still listens after 2 minutes: killing PID $pid and its child processes"
            if command -v taskkill >/dev/null 2>&1; then taskkill //PID "$pid" //T //F >/dev/null; else kill -9 "$pid"; fi
        fi
    fi
    [ -z "$(listener_pid)" ] && echo "Nothing listens on port $JIRA_HTTP_PORT"
}

status() {
    local pid
    pid="$(listener_pid)"
    echo "URL:      $BASE_URL"
    echo "Workdir:  $JIRA_WORKDIR"
    echo "Listener: ${pid:-none}"
    echo "State:    $(jira_state)"
    echo "Version:  $(jira_version)"
}

case "${1:-}" in
    start) check_free; launch bg ;;
    run) check_free; launch fg ;;
    wait) wait_ready ;;
    stop) stop ;;
    status) status ;;
    *) sed -n '3,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
