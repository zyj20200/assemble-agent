# assemble-agent 生产镜像
# 用 slim（debian glibc）保证 better-sqlite3 有预编译产物；运行时直接跑 TS（Node 24 原生类型剥离）

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 需源码编译（slim 镜像无 Python/工具链）
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
# 安装全部依赖（含 dev；编译产物随 node_modules 拷入最终镜像）
RUN npm ci
COPY drizzle ./drizzle
COPY src ./src
COPY scripts ./scripts
COPY web ./web
COPY tsconfig.json ./

# 精简：仅运行时依赖
RUN npm prune --omit=dev

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/web ./web
COPY --from=build /app/package.json ./

# 数据目录（SQLite + 上传临时文件）
RUN mkdir -p /app/data
VOLUME ["/app/data"]
ENV ASSEMBLE_DB_PATH=/app/data/assemble.db

EXPOSE 8787
# 启动前先播种（幂等：已有数据自动跳过）；随后启动服务
CMD ["sh", "-c", "node scripts/seed.ts 2>/dev/null; exec node src/index.ts"]
