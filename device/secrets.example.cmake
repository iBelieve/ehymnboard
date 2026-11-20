# Copy to secrets.cmake (gitignored) and replace the key.
#
# AES key for encrypting OTA images: up to 32 characters from [0-9a-zA-Z].
# Generate one with:
#   python3 -c "import secrets, string; print(''.join(secrets.choice(string.ascii_letters + string.digits) for _ in range(32)))"
#
# Every board decrypts updates with the key of the firmware it is running, so
# keep this key: an image built with a different key can't be installed OTA.
set(PFB_AES_KEY "CHANGEME")
