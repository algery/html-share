FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /renderer
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-audit --no-fund --ignore-scripts --save-exact playwright@1.62.1
COPY apps/cover-renderer/*.mjs ./

ENV HOME=/tmp PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
USER 1000:1000
CMD ["node", "/renderer/server.mjs"]
