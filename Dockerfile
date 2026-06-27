FROM node:20

# ඇප් එකට අවශ්‍ය system dependencies ඉන්ස්ටෝල් කරගන්නවා
RUN apt-get update && apt-get install -y \
    chromium \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# package.json එක copy කරලා dependencies ඉන්ස්ටෝල් කරනවා
COPY package.json ./
RUN npm install

# මුළු කෝඩ් එකම copy කරනවා
COPY . .

# ඇප් එක රන් වෙන Port එක open කරනවා
EXPOSE 3000

# ඇප් එක ස්ටාර්ට් කරන කෝඩ් එක
CMD ["npm", "start"]
