#!/bin/bash
# Restores the default macOS GPU memory limit and removes the LaunchDaemon.
sudo launchctl bootout system/local.gpu-wired-limit 2>/dev/null
sudo rm -f /Library/LaunchDaemons/local.gpu-wired-limit.plist
sudo sysctl iogpu.wired_limit_mb=0
echo "Restored the default macOS limit."
read -n1 -r -p "Press any key..."
