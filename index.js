import cron from "node-cron";
import { google } from "googleapis";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import fs from "fs/promises";
import path from "path";
import { format } from "date-fns";
import dotenv from "dotenv";
import crypto from "crypto";
import winston from "winston";
import { exec } from "child_process";
import "winston-daily-rotate-file";

dotenv.config();

// Configure daily rotation logging
const transport = new winston.transports.DailyRotateFile({
  filename: "logs/%DATE%-combined.log",
  datePattern: "YYYY-MM-DD",
  maxSize: "20m",
  maxFiles: "14d",
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
});

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [transport, new winston.transports.Console()],
});

// Check for required environment variables
const googleCredentialsPath = process.env.GOOGLE_CREDENTIALS_PATH;
if (!googleCredentialsPath) {
  throw new Error("GOOGLE_CREDENTIALS_PATH environment variable is not set.");
}

// Google Sheets credentials
const sheets = google.sheets("v4");
const auth = new google.auth.GoogleAuth({
  keyFile: googleCredentialsPath,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const spreadsheetId = process.env.SPREADSHEET_ID;
const range = "2024!A1"; // Updated sheet name

// AWS S3 credentials
const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Ensure directory exists
async function ensureDirectoryExists(dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
    logger.info(`Directory created: ${dirPath}`);
  } catch (error) {
    logger.error(`Error creating directory ${dirPath}: ${error.message}`);
  }
}

// Run Lighthouse and save results
async function runLighthouse(url, device, size, id) {
  return new Promise((resolve, reject) => {
    let screenEmulation = "";
    if (device === "mobile") {
      screenEmulation = `--screenEmulation.mobile --screenEmulation.width=${size.width} --screenEmulation.height=${size.height} --screenEmulation.deviceScaleFactor=2`;
    } else if (device === "desktop") {
      screenEmulation = `--screenEmulation.mobile=false --screenEmulation.width=${size.width} --screenEmulation.height=${size.height} --screenEmulation.deviceScaleFactor=1 --preset=desktop`;
    }
    const command = `lighthouse ${url} --chrome-flags="--headless" --output=json --output=html --output-path=./outputs/${id} --quiet --form-factor=${device} ${screenEmulation}`;
    logger.info(`Running command ${command}`);
    exec(command, async (error, stdout, stderr) => {
      if (error) {
        logger.error(`Error running Lighthouse for ${url}: ${error.message}`);
        reject(error);
      } else {
        logger.info(`Lighthouse run successful for ${url}`);
        const jsonContent = await fs.readFile(
          `./outputs/${id}.report.json`,
          "utf-8"
        );
        const result = {
          lhr: JSON.parse(jsonContent),
        };
        resolve(result);
      }

      if (stderr) {
        logger.error(`Lighthouse stderr for ${url}: ${stderr}`);
      }
    });
  });
}
// Save JSON data to Google Sheets
async function saveToGoogleSheets(data) {
  const authClient = await auth.getClient();

  const values = [
    [
      data.date,
      data.device,
      data.urlKey,
      data.lhr.finalUrl,
      data.lhr.categories.performance?.score ?? "N/A",
      data.lhr.categories.accessibility?.score ?? "N/A",
      data.lhr.categories["best-practices"]?.score ?? "N/A",
      data.lhr.categories.seo?.score ?? "N/A",
      data.lhr.categories.pwa?.score ?? "N/A",
      data.lhr.userAgent,
      data.link,
    ],
  ];

  try {
    await sheets.spreadsheets.values.append({
      auth: authClient,
      spreadsheetId: spreadsheetId,
      range: range,
      valueInputOption: "RAW",
      resource: {
        values: values,
      },
    });
    logger.info("Data saved to Google Sheets");
  } catch (error) {
    logger.error(`Error saving data to Google Sheets: ${error.message}`);
    throw error;
  }
}

// Upload HTML file to S3
async function uploadToS3(filePath, bucketName, s3Path) {
  const fileContent = await fs.readFile(filePath);

  const params = {
    Bucket: bucketName,
    Key: s3Path,
    Body: fileContent,
    ContentType: "text/html",
  };

  const command = new PutObjectCommand(params);

  try {
    await s3Client.send(command);
    logger.info(`File uploaded to S3: ${s3Path}`);
  } catch (error) {
    logger.error(`Error uploading file to S3: ${error.message}`);
    throw error;
  }
}

function hashStringTo12Digits(input) {
  // Create a SHA-256 hash of the input
  const hash = crypto.createHash("sha256").update(input).digest("hex");

  // Convert the hash to base 36 to shorten its length
  const base36Hash = BigInt("0x" + hash).toString(36);

  // Trim or pad the result to 12 digits
  return base36Hash.slice(0, 12).padStart(12, "0");
}

// Main function to run Lighthouse, save results, and upload to S3
async function runAndSave(url, opts, bucketName) {
  const startTime = new Date();
  const urlKey = hashStringTo12Digits(url);
  logger.info(
    `Processing started at ${startTime.toISOString()} for URL: ${url}`
  );

  // Ensure the outputs directory exists
  await ensureDirectoryExists("outputs");

  let result;
  try {
    result = await runLighthouse(
      url,
      opts.device,
      opts.size,
      startTime.getTime()
    );
    logger.info(`Lighthouse run successful for ${url}`);
  } catch (error) {
    logger.error(`Error running Lighthouse for ${url}: ${error.message}`);
    return; // Exit if Lighthouse run fails
  }

  const fileName = `${startTime.toISOString()}-${urlKey}-lighthouse-report-${
    opts.device
  }.html`;
  const tempName = `${startTime.getTime()}.report.html`;
  const jsonTempName = `${startTime.getTime()}.report.json`;
  const filePath = path.join("outputs", tempName);
  const jsonFilePath = path.join("outputs", jsonTempName);
  const datePrefix = format(new Date(), "yyyy-MM-dd");
  const s3Path = `${datePrefix}/${fileName}`;
  const link = `${process.env.HOST}/${s3Path}`;

  try {
    // Write the HTML report to a file in the outputs directory
    logger.info(`HTML report written to file: ${filePath}`);

    // Check the structure of result.lhr
    if (!result.lhr || !result.lhr.categories) {
      throw new Error("Invalid Lighthouse result structure");
    }

    // Save JSON data to Google Sheets with the device type in the correct position
    await saveToGoogleSheets({
      lhr: {
        finalUrl: result.lhr.finalUrl,
        categories: {
          performance: {
            score: result.lhr.categories.performance?.score ?? "N/A",
          },
          accessibility: {
            score: result.lhr.categories.accessibility?.score ?? "N/A",
          },
          "best-practices": {
            score: result.lhr.categories["best-practices"]?.score ?? "N/A",
          },
          seo: { score: result.lhr.categories.seo?.score ?? "N/A" },
          pwa: { score: result.lhr.categories.pwa?.score ?? "N/A" },
        },
        userAgent: result.lhr.userAgent,
      },
      device: opts.device, // Pass device type to the function
      date: startTime.toISOString(),
      urlKey: urlKey,
      link: link,
    });

    // // Upload HTML report to S3
    // await uploadToS3(filePath, bucketName, s3Path);
  } catch (error) {
    logger.error(`Error during saving or uploading: ${error.message}`);
  } finally {
    // Delete the local HTML file
    try {
      // await fs.unlink(filePath);
      // await fs.unlink(jsonFilePath);
      logger.info(`Local HTML file deleted: ${filePath}`);
    } catch (error) {
      logger.error(`Error deleting local HTML file: ${error.message}`);
    }
  }

  const endTime = new Date();
  logger.info(`Processing ended at ${endTime.toISOString()} for URL: ${url}`);
  logger.info(`Processing time: ${endTime - startTime} ms`);
}

const desktopOpts = {
  device: "desktop",
  size: {
    width: 1366,
    height: 768,
    deviceScaleFactor: 1,
    mobile: false,
    disabled: false,
  },
  output: "html",
};

const mobileOpts = {
  device: "mobile",
  size: {
    mobile: true,
    width: 375, // iPhone 6/7/8 plus screen width
    height: 667, // iphone 6/7/8 plus screen height
    deviceScaleFactor: 1.75, // iphone 6/7/8 plus screen density
    disabled: false,
  },
  output: "html",
};

async function processLighthouse() {
  const urls = process.env.TARGET_URL.split(",");
  const bucketName = process.env.S3_BUCKET_NAME;
  try {
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      await runAndSave(url, desktopOpts, bucketName);
      await runAndSave(url, mobileOpts, bucketName);
    }
  } catch (error) {
    logger.error(`Error during scheduled task: ${error.message}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const isDev = args.includes("--dev");

  if (isDev) {
    processLighthouse();
  } else {
    logger.info(`Cron 0 * * * * is started`);
    cron.schedule("0 * * * *", async () => {
      processLighthouse();
    });
  }
}

main();
