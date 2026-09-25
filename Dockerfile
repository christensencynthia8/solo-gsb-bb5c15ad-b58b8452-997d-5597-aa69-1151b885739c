FROM node:20-alpine

WORKDIR /app

# 先装依赖，充分利用镜像层缓存
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# 拷贝源码（data/ 由容器内卷提供或自动初始化，见 .dockerignore）
COPY server.js ./
COPY public ./public

ENV PORT=3000
EXPOSE 3000

# 启动时自动创建数据目录并初始化示例数据（若数据文件不存在）
CMD ["node", "server.js"]
