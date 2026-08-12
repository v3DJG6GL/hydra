#!/bin/sh
# Runs from /docker-entrypoint.d before nginx starts: make sure /certs holds
# a TLS keypair for the :8443 listener. Self-signed is the point — on a LAN
# rig each controlling device accepts the browser warning once, and the deck
# becomes a secure context (Web MIDI, mic, wake lock). Mount /certs as a
# volume so the cert (and the accepted exceptions) survive recreates; drop
# your own hydra.crt/hydra.key there to use a real or mkcert-issued pair.
set -e
if [ -s /certs/hydra.crt ] && [ -s /certs/hydra.key ]; then
    exit 0
fi
# SANs only matter once a device IMPORTS the cert as trusted (clicking
# through the warning ignores them) — so list every name/IP the rig is
# reached by, e.g. HYDRA_TLS_SAN=DNS:localhost,IP:127.0.0.1,IP:192.168.88.100
san="${HYDRA_TLS_SAN:-DNS:localhost,IP:127.0.0.1}"
# CA:TRUE lets Firefox/LibreWolf/Android import the cert into their
# authority store, turning :8443 into a fully valid origin — which is what
# Firefox-family browsers require before they grant Web MIDI (they deny it
# silently on cert-override origins). nginx serves the public half at
# /hydra.crt for exactly that import.
openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
    -keyout /certs/hydra.key -out /certs/hydra.crt \
    -subj "/CN=hydra-lan" -addext "subjectAltName=$san" \
    -addext "basicConstraints=critical,CA:TRUE" 2>/dev/null
echo "hydra: generated self-signed TLS cert (SAN $san) in /certs"
