#!/usr/bin/env bash
# Installs the virtual display, software OpenGL and Vulkan, video encoder and audio server.
set -euo pipefail
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  xvfb xauth x11-xkb-utils xkb-data libgl1 libgl1-mesa-dri libglx-mesa0 libegl1 \
  mesa-vulkan-drivers libvulkan1 \
  ffmpeg pulseaudio libpulse0 libopenal1 \
  libxcursor1 libxrandr2 libxxf86vm1 libxi6 libxtst6 libxrender1 libxext6 libasound2
npm ci
