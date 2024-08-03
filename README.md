# Lighthouse Performance Monitoring

This project runs Lighthouse performance tests on specified URLs, saves the results to Google Sheets, and uploads the HTML reports to AWS S3.

## Setup

```
npm install
```

## Run

### Run Test Cronjob

```
npm start
```

### Run Development

```
npm run start:dev
```

### Run Production

```
npm install -g pm2
pm2 start index.js --name "lighthouse-monitor"
```

### Prerequisites

- Node.js (version 20 or higher)
- npm (Node Package Manager)
- AWS account with S3 bucket
- Google Cloud account with access to Google Sheets API

### Environment Variables

Create a `.env` file in the root of your project with the following variables:

```dotenv
SPREADSHEET_ID=your-google-sheet-id
GOOGLE_CREDENTIALS_PATH=./path/to/google-credentials.json
AWS_REGION=your-aws-region
AWS_ACCESS_KEY_ID=your-access-key-id
AWS_SECRET_ACCESS_KEY=your-secret-access-key
S3_BUCKET_NAME=your-s3-bucket-name
TARGET_URL=https://example1.com,https://example2.com
```
