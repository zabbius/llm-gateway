#!/usr/bin/env bash
#
# tools/generate-tls-cert.sh — generate the self-signed TLS certificate/key
# pair for the gateway's TLS mode. The system openssl is the only dependency:
# no keys, packages, or downloads beyond it.
#
#   tools/generate-tls-cert.sh [--hostname <name>] [--san <value>]...
#                              [--days <n>] [--out-dir <dir>] [--force]
#
# Writes cert.pem (mode 644) and key.pem (mode 600) into the out dir and
# verifies the pair before reporting success. Existing files are never
# overwritten without --force.

set -u
set -o pipefail
umask 077

readonly SCRIPT_NAME="tools/generate-tls-cert.sh"

# Runtime failure: one problem line on stderr, non-zero exit.
die() { echo "${SCRIPT_NAME}: $*" >&2; exit 1; }

# Bad invocation: problem line plus the one-line usage, like tls-fingerprint.
usage_problem() {
  echo "${SCRIPT_NAME}: $*" >&2
  echo "usage: ${SCRIPT_NAME} [--hostname <name>] [--san <value>]... [--days <n>] [--out-dir <dir>] [--force]  (--help for details)" >&2
  exit 1
}

help() {
  cat <<'EOF'
usage: tools/generate-tls-cert.sh [--hostname <name>] [--san <value>]...
                                  [--days <n>] [--out-dir <dir>] [--force]

Generates a self-signed TLS certificate (cert.pem) and private key (key.pem)
for the gateway's TLS mode with `openssl req -x509 -newkey` (RSA 2048,
SHA-256, unencrypted key — a server key the gateway must read at startup).
The only dependency is the system openssl.

Options:
  --hostname <name>  Certificate Common Name; always included in the
                     subjectAltName as DNS:<name> (default: localhost)
  --san <value>      Extra subjectAltName entries — repeatable and
                     comma-separable. A bare value is classified by shape:
                     an IPv4/IPv6 literal becomes IP:<value>, anything else
                     DNS:<value>. An explicit DNS:/IP: prefix passes through
                     unchanged (e.g. DNS:gateway.lan, IP:10.0.0.5, IP:::1).
  --days <n>         Validity in days, a positive integer (default: 365)
  --out-dir <dir>    Directory that receives cert.pem and key.pem; created
                     when missing (default: ./tls)
  --force            Overwrite existing cert.pem/key.pem; without it the
                     script refuses to overwrite either file
  -h, --help         This help

The certificate is a server leaf: basicConstraints CA:FALSE, keyUsage
digitalSignature + keyEncipherment, extendedKeyUsage serverAuth. After
generation the script re-reads both files with openssl and checks that the
cert/key public keys match before declaring success.

Examples:
  tools/generate-tls-cert.sh
  tools/generate-tls-cert.sh --hostname gateway.lan \
      --san DNS:api.gateway.lan --san IP:10.0.0.5 --days 30
  tools/generate-tls-cert.sh --force --san 'IP:127.0.0.1,IP:::1'

Self-signed output is trusted by nothing by default: point clients at it via
the upstream tlsFingerprint pin (compute it with
`bun tools/tls-fingerprint.ts https://<host>:<port>/`) instead of disabling
certificate verification anywhere.
EOF
  exit 0
}

trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# Reject anything that could corrupt the -subj string or the SAN CSV.
guard_token() {
  local kind="$1" value="$2"
  [ -n "$value" ] || usage_problem "empty $kind"
  case "$value" in
    *[[:space:]]*|*,*|*/*) usage_problem "invalid $kind \"$value\" (no whitespace, commas, or slashes)" ;;
  esac
}

# Validators below set *_parsed globals and call usage_problem directly from
# the main shell — command substitution would turn their exit into a subshell
# exit and let invalid input fall through to openssl.

validate_hostname() {
  local h
  h="$(trim "$1")"
  guard_token "--hostname" "$h"
  hostname_parsed="$h"
}

# One subjectAltName entry: explicit DNS:/IP: prefixes pass through with the
# prefix normalized to upper case; bare values are classified by shape
# (IPv4 dotted quad or IPv6 hex/colon run → IP:, otherwise a DNS name).
# openssl remains the final validator of the value itself.
classify_san() {
  local raw v
  raw="$(trim "$1")"
  [ -n "$raw" ] || usage_problem "empty --san entry"
  case "$raw" in
    *[[:space:]]*|*,*|*/*) usage_problem "invalid --san entry \"$raw\" (no whitespace, commas, or slashes)" ;;
  esac
  case "$raw" in
    [Dd][Nn][Ss]:*)
      v="${raw#*:}"
      [ -n "$v" ] || usage_problem "invalid --san entry \"$raw\""
      san_parsed="DNS:$v"
      return
      ;;
    [Ii][Pp]:*)
      v="${raw#*:}"
      [ -n "$v" ] || usage_problem "invalid --san entry \"$raw\""
      san_parsed="IP:$v"
      return
      ;;
  esac
  if [[ "$raw" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
    san_parsed="IP:$raw"
    return
  fi
  if [[ "$raw" =~ ^[0-9A-Fa-f:]+$ && "$raw" == *:* ]]; then
    san_parsed="IP:$raw"
    return
  fi
  if [[ "$raw" =~ ^[A-Za-z0-9_*.-]+$ ]]; then
    san_parsed="DNS:$raw"
    return
  fi
  usage_problem "invalid --san entry \"$raw\" (expected a DNS name, an IP literal, or a DNS:/IP: prefixed value)"
}

# Split one --san value on commas and classify each element.
add_san_value() {
  local raw="$1" element
  local elements=()
  local IFS=','
  read -r -a elements <<< "$raw"
  for element in "${elements[@]}"; do
    classify_san "$element"
    sans+=("$san_parsed")
  done
}

validate_days() {
  local d
  d="$(trim "$1")"
  if ! [[ "$d" =~ ^[0-9]+$ ]] || [ "$d" -lt 1 ]; then
    usage_problem "--days requires a positive integer, got \"$1\""
  fi
  days_parsed="$d"
}

command -v openssl >/dev/null 2>&1 \
  || die "openssl not found in PATH — the system openssl is required"

hostname="localhost"
hostname_parsed=""
days="365"
days_parsed=""
out_dir="./tls"
force=0
sans=()
san_parsed=""

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)
      help
      ;;
    --hostname)
      [ $# -ge 2 ] || usage_problem "--hostname requires a name argument"
      validate_hostname "$2"
      hostname="$hostname_parsed"
      shift 2
      ;;
    --hostname=*)
      validate_hostname "${1#*=}"
      hostname="$hostname_parsed"
      shift
      ;;
    --san)
      [ $# -ge 2 ] || usage_problem "--san requires a value argument"
      add_san_value "$2"
      shift 2
      ;;
    --san=*)
      add_san_value "${1#*=}"
      shift
      ;;
    --days)
      [ $# -ge 2 ] || usage_problem "--days requires a value argument"
      validate_days "$2"
      days="$days_parsed"
      shift 2
      ;;
    --days=*)
      validate_days "${1#*=}"
      days="$days_parsed"
      shift
      ;;
    --out-dir)
      [ $# -ge 2 ] || usage_problem "--out-dir requires a directory argument"
      out_dir="$(trim "$2")"
      [ -n "$out_dir" ] || usage_problem "empty --out-dir"
      shift 2
      ;;
    --out-dir=*)
      out_dir="$(trim "${1#*=}")"
      [ -n "$out_dir" ] || usage_problem "empty --out-dir"
      shift
      ;;
    --force)
      force=1
      shift
      ;;
    *)
      usage_problem "unknown option \"$1\""
      ;;
  esac
done

# Final SAN list: DNS:<hostname> first, user entries after it, deduplicated.
san_entries=("DNS:$hostname")
for san in "${sans[@]}"; do
  duplicate=0
  for entry in "${san_entries[@]}"; do
    [ "$san" = "$entry" ] && duplicate=1
  done
  [ "$duplicate" -eq 1 ] || san_entries+=("$san")
done
san_csv="$(IFS=','; printf '%s' "${san_entries[*]}")"

cert_path="$out_dir/cert.pem"
key_path="$out_dir/key.pem"

mkdir -p "$out_dir" || die "cannot create out dir \"$out_dir\""

existing=""
[ -e "$cert_path" ] && existing="$cert_path"
[ -e "$key_path" ] && existing="${existing:+$existing and }$key_path"
if [ -n "$existing" ] && [ "$force" -ne 1 ]; then
  die "refusing to overwrite $existing — rerun with --force to replace"
fi

openssl req -x509 \
  -newkey rsa:2048 \
  -sha256 \
  -nodes \
  -days "$days" \
  -subj "/O=llm-gateway/CN=$hostname" \
  -addext "subjectAltName=$san_csv" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth" \
  -keyout "$key_path" \
  -out "$cert_path" || die "openssl req failed — no usable pair was written"

chmod 600 "$key_path"
chmod 644 "$cert_path"

# Verify what was written: both files must parse and carry the same key.
cert_pub="$(openssl x509 -in "$cert_path" -pubkey -noout 2>/dev/null \
  | openssl pkey -pubin -outform DER 2>/dev/null \
  | openssl dgst -sha256 2>/dev/null)" \
  || die "verification failed: \"$cert_path\" is not a readable certificate"
key_pub="$(openssl pkey -in "$key_path" -pubout -outform DER 2>/dev/null \
  | openssl dgst -sha256 2>/dev/null)" \
  || die "verification failed: \"$key_path\" is not a readable private key"
if [ -z "$cert_pub" ] || [ "$cert_pub" != "$key_pub" ]; then
  die "verification failed: \"$cert_path\" and \"$key_path\" do not form a matching pair"
fi

echo "Self-signed pair generated and verified:"
echo "  cert:  $cert_path  (subject: O=llm-gateway, CN=$hostname)"
echo "  key:   $key_path  (chmod 600)"
echo "  SAN:   $san_csv"
echo "  valid: $days days"
echo "Inspect: openssl x509 -in \"$cert_path\" -noout -text"
echo "Pin for the upstream config (tlsFingerprint): bun tools/tls-fingerprint.ts https://<host>:<port>/"
