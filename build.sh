#!/bin/bash

# Clone the repository
git clone https://github.com/your/repo.git

# Navigate into the levanter folder
cd levanter

# Install dependencies
npm install

# Properly install dependencies
if [ -f yarn.lock ]; then
    yarn install
fi