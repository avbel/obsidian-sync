# ./out is produced on the CI runner by `pnpm deploy --prod`; see
# .github/workflows/release.yml. This image only copies it, so there is no
# pnpm, no toolchain and no compile step here. The server has no native
# dependencies, which is why one build output is valid for every architecture.
FROM gcr.io/distroless/nodejs26-debian13:nonroot
WORKDIR /app
COPY --chown=nonroot:nonroot out ./
ENV DATA_DIR=/data
EXPOSE 3000
CMD ["/app/dist/index.js"]
