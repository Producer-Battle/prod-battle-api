FROM node:22-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY run.mjs ./
# No deps yet - uses only @aws-sdk/client-s3 which can be added later.
# RUN npm install --omit=dev
ENTRYPOINT ["node", "run.mjs"]
