#!/bin/bash
cd "$(dirname "$0")" || exit 1
exec node server/server.js
