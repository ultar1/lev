#!/usr/bin/env bash

# Exit on error
set -e

echo "Starting Postbuild Process..."

# 1. Remove old folder if it exists (for fresh builds)
if [ -d "levanter" ]; then
    echo "Cleaning up old levanter directory..."
    rm -rf levanter
fi

# 2. Clone the repository
echo "Cloning Levanter..."
git clone https://github.com/lyfe00011/levanter.git levanter

# 3. Install dependencies inside the levanter folder
echo "Installing Levanter dependencies..."
cd levanter
npm install --network-concurrency 1 --force

echo "Build complete!"
