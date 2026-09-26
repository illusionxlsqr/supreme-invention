FROM node:20-bookworm-slim

# Install system dependencies: git, python3, curl, unzip, ca-certificates
RUN apt-get update && apt-get install -y \
    git \
    python3 \
    curl \
    unzip \
    ca-certificates \
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

# Download official Linux Luau binaries (luau and luau-ast) for Linux and set permissions
RUN curl -sL https://github.com/luau-lang/luau/releases/latest/download/luau-ubuntu.zip -o /tmp/luau-ubuntu.zip && \
    unzip -o /tmp/luau-ubuntu.zip luau luau-ast -d ./Deobfuscator-Luraph-V15/bin/ && \
    chmod +x ./Deobfuscator-Luraph-V15/bin/luau* && \
    rm -f /tmp/luau-ubuntu.zip

# Copy all source files
COPY . .

# Set default environment variables
ENV PYTHON_BIN=python3
ENV DEOBF_DIR=/app/Deobfuscator-Luraph-V15
ENV DEOBF_TIMEOUT_MS=180000

# Start bot
CMD ["node", "bot.js"]
