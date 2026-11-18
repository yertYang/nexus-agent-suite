FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY LICENSE .
COPY scripts/lib.mjs ./scripts/
COPY src/cpr.mjs src/net.mjs ./src/
COPY team/main.mjs team/site.mjs team/deployments.mjs team/files.mjs team/tasks.mjs team/cli-input.mjs team/store.mjs team/validation.mjs ./team/
COPY team/public/index.html team/public/team.js team/public/files-ui.js team/public/team.css ./team/public/
COPY public/ui/tokens.css public/ui/components.css public/ui/chevron-down.svg public/ui/LICENSE ./public/ui/
COPY deploy/team/health.mjs ./deploy/team/
ENV NODE_ENV=production NAVI_TEAM_DATA=/var/lib/navi-team
RUN install -d -o node -g node -m 0700 /var/lib/navi-team
USER node
HEALTHCHECK --interval=5s --timeout=4s --start-period=5s --retries=5 CMD ["node", "deploy/team/health.mjs"]
ENTRYPOINT ["node", "team/main.mjs"]
CMD ["serve"]
