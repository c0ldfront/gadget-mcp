FROM oven/bun:1 AS builder
WORKDIR /src

COPY package.json bun.lock ./
COPY packages/core/package.json ./packages/core/
COPY packages/server/package.json ./packages/server/
RUN bun install --frozen-lockfile

COPY tsconfig.json biome.json bunfig.toml ./
COPY packages ./packages
COPY data ./data
COPY forge.ts ./

RUN bun build ./packages/server/src/cli.ts \
      --compile \
      --target=bun-linux-x64 \
      --outfile /out/gadget-mcp

FROM gcr.io/distroless/base-debian12:nonroot AS runtime
LABEL org.opencontainers.image.title="gadget-mcp"
LABEL org.opencontainers.image.source="https://github.com/c0ldfront/gadget-mcp"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app
COPY --from=builder /out/gadget-mcp /usr/local/bin/gadget-mcp
COPY --from=builder /src/data /app/data

ENV GADGET_HTTP_HOST=0.0.0.0
ENV GADGET_HTTP_PORT=7878
ENV GADGET_DB=/data/gadget.db

EXPOSE 7878
VOLUME ["/data"]

USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/gadget-mcp"]
CMD ["--http"]
