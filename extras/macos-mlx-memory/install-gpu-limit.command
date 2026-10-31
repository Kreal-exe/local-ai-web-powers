#!/bin/bash
# Raises the GPU wired-memory limit on a 16 GB Mac and keeps it after reboots (LaunchDaemon).
# macOS gives the GPU about 10.7 GB by default. The value is in megabytes:
#   12288 = 12 GB  (recommended, leaves 4 GB to the system)
#   13312 = 13 GB  (sensible maximum; close Chrome and other heavy apps)
# Usage: ./install-gpu-limit.command [MB]   (asks for an admin password)
LIMIT_MB="${1:-12288}"
case "$LIMIT_MB" in (*[!0-9]*|"") echo "The limit must be a number of megabytes, e.g. 12288"; exit 1;; esac
PLIST=/Library/LaunchDaemons/local.gpu-wired-limit.plist
echo "Setting the GPU memory limit to ${LIMIT_MB} MB (admin password required)"
sudo tee "$PLIST" >/dev/null <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.gpu-wired-limit</string>
  <key>ProgramArguments</key><array><string>/usr/sbin/sysctl</string><string>iogpu.wired_limit_mb=${LIMIT_MB}</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
PL
sudo chown root:wheel "$PLIST"; sudo chmod 644 "$PLIST"
sudo launchctl bootout system/local.gpu-wired-limit 2>/dev/null
sudo launchctl bootstrap system "$PLIST"
sudo sysctl iogpu.wired_limit_mb="${LIMIT_MB}"
echo "Done. Now: $(sysctl -n iogpu.wired_limit_mb) MB. Applied automatically at every boot."
echo "Reload the model in LM Studio (Eject -> Load) to use the new limit."
read -n1 -r -p "Press any key..."
