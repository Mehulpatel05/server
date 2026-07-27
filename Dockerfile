FROM node:18-alpine

# Install python3, ffmpeg, curl and ca-certificates
RUN apk add --no-cache python3 ffmpeg curl ca-certificates

# Download and install yt-dlp binary to /usr/local/bin
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

# Set working directory inside container
WORKDIR /usr/src/app

# Copy dependency configs
COPY package*.json ./

# Install npm production dependencies
RUN npm install --only=production

# Copy server code
COPY . .

# Expose HTTP port
EXPOSE 8080

# Run express app
CMD [ "node", "index.js" ]
