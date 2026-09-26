FROM node:20-bookworm-slim

# Install system dependencies: git, python3, and curl
RUN apt-get update && apt-get install -y \
    git \
    python3 \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install bot dependencies
RUN npm install --production

# Clone and install Luraph V15 deobfuscator
RUN git clone https://github.com/caomod2077/Deobfuscator-Luraph-V15.git ./Deobfuscator-Luraph-V15 && \
    cd ./Deobfuscator-Luraph-V15 && \
    npm install --production && \
    cd ..

# Copy all source files
COPY . .

# Set default environment variables
ENV PYTHON_BIN=python3
ENV DEOBF_DIR=/app/Deobfuscator-Luraph-V15
ENV DEOBF_TIMEOUT_MS=180000

# Start bot
CMD ["node", "bot.js"]
