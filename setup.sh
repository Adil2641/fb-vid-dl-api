#!/bin/bash
set -o errexit

echo "Installing Node.js dependencies..."
npm install --production

echo "Running any additional build steps..."
# Add any additional build commands here if needed