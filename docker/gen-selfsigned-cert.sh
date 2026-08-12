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
# SANs are cosmetic here (an unknown CA warns regardless); override with
# e.g. HYDRA_TLS_SAN=DNS:localhost,IP:127.0.0.1,IP:192.168.88.100
san="${HYDRA_TLS_SAN:-DNS:localhost,IP:127.0.0.1}"
openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
    -keyout /certs/hydra.key -out /certs/hydra.crt \
    -subj "/CN=hydra-lan" -addext "subjectAltName=$san" 2>/dev/null
echo "hydra: generated self-signed TLS cert (SAN $san) in /certs"
