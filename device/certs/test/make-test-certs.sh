#!/usr/bin/env bash
# Makes the certificates the emulator's TLS server uses, for firmware built
# with -DEHYMNBOARD_TEST_ROOT_CA=ON (which trusts root.pem as well as
# ../roots.pem). Test only: the private keys are public, here in the
# repository, so a build that trusts root.pem must never reach a real board
# (CMakeLists.txt refuses to make one with a real OTA key).
#
# Run from this directory to regenerate them all; the emulator tests then
# need a firmware rebuild.
set -euo pipefail

DAYS=36500 # no date checks on the board; these never need renewing
HOST=hymnboard.sonrise.io

ec_key() { openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$1"; }

# name, key, issuer cert, issuer key, extensions, output
sign() {
    openssl req -new -key "$2" -subj "/O=eHymnBoard tests/CN=$1" |
        openssl x509 -req -CA "$3" -CAkey "$4" -days "$DAYS" -set_serial "0x$(openssl rand -hex 8)" \
            -extfile <(printf '%s\n' "$5") -out "$6"
}

# The root the test firmware trusts, and an intermediate under it, as real
# chains have
ec_key root.key
openssl req -new -x509 -key root.key -subj "/O=eHymnBoard tests/CN=eHymnBoard Test Root CA" \
    -days "$DAYS" -addext 'basicConstraints=critical,CA:true' \
    -addext 'keyUsage=critical,keyCertSign,cRLSign' -out root.pem
# cmake/embed_roots.py wants a name above each root
printf '%s\n%s\n' '# Name: eHymnBoard Test Root CA (tests only)' "$(cat root.pem)" >root.pem.tmp
mv root.pem.tmp root.pem
ec_key intermediate.key
sign "eHymnBoard Test Issuing CA" intermediate.key root.pem root.key "basicConstraints=critical,CA:true
keyUsage=critical,keyCertSign,cRLSign" intermediate.pem

leaf() { # file, name, key, SAN
    sign "$2" "$3" intermediate.pem intermediate.key "basicConstraints=critical,CA:false
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=$4" "$1.pem"
    cat intermediate.pem >>"$1.pem"
}

# The server's certificate (ECDSA, like Cloudflare's), then the same name
# with an RSA key, then a valid chain for another name
ec_key server.key
leaf server "$HOST" server.key "DNS:$HOST"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out server-rsa.key
leaf server-rsa "$HOST" server-rsa.key "DNS:$HOST"
leaf wrong-host other.example server.key "DNS:other.example"
# For the WebSocket client under the Autobahn suite (emulator/autobahn)
leaf autobahn autobahn.test server.key "DNS:autobahn.test"

# The right name, from a CA the board doesn't trust
ec_key untrusted-root.key
openssl req -new -x509 -key untrusted-root.key -subj "/O=eHymnBoard tests/CN=Untrusted Root CA" \
    -days "$DAYS" -addext 'basicConstraints=critical,CA:true' \
    -addext 'keyUsage=critical,keyCertSign,cRLSign' -out untrusted-root.pem
sign "$HOST" server.key untrusted-root.pem untrusted-root.key "basicConstraints=critical,CA:false
subjectAltName=DNS:$HOST" untrusted.pem

rm -f root.key intermediate.key untrusted-root.key untrusted-root.pem
