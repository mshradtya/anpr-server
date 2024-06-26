const net = require("net");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");
const xml2js = require("xml2js");

// MongoDB connection details
const mongoURL = "mongodb://localhost:27017";
const dbName = "anpr_data";
const collectionName = "event_notifications";

// Function to get local IP address
function getLocalIPAddress() {
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    for (const config of iface) {
      if (config.family === "IPv4" && !config.internal) {
        return config.address;
      }
    }
  }
  throw new Error(
    "No Ethernet network adapters with an IPv4 address in the system!"
  );
}

const localIP = getLocalIPAddress();
const server = net.createServer();

// Function to extract form data
function extractFormData(requestData, boundaryString) {
  const formDataList = [];
  const boundaryBytes = Buffer.from(boundaryString, "ascii");
  let currentIndex = 0;

  while (currentIndex < requestData.length) {
    const headerStartIndex = requestData.indexOf(
      Buffer.from("Content-Disposition: form-data;"),
      currentIndex
    );
    if (headerStartIndex === -1) break;
    const headerEndIndex = requestData.indexOf(
      Buffer.from("\r\n\r\n"),
      headerStartIndex
    );
    if (headerEndIndex === -1) break;

    const header = requestData
      .slice(headerStartIndex, headerEndIndex)
      .toString("ascii");
    const filenameMatch = header.match(/filename="([^"]+)"/);
    const contentTypeMatch = header.match(/Content-Type: ([^\r\n]+)/);

    const filename = filenameMatch ? filenameMatch[1] : null;
    const contentType = contentTypeMatch
      ? contentTypeMatch[1]
      : "application/octet-stream";

    const contentStartIndex = headerEndIndex + 4;
    let boundaryIndex = requestData.indexOf(boundaryBytes, contentStartIndex);
    if (boundaryIndex === -1) boundaryIndex = requestData.length;

    const contentLength = boundaryIndex - contentStartIndex;
    const contentData = requestData.slice(
      contentStartIndex,
      contentStartIndex + contentLength
    );

    formDataList.push({
      contentType,
      filename,
      content: contentData,
    });

    currentIndex = boundaryIndex + boundaryBytes.length;
  }

  return formDataList;
}

// Function to get boundary string
function getBoundary(requestData) {
  const header = requestData.toString("ascii");
  const match = header.match(/boundary=(.*?)(\r\n|$)/);
  if (match) {
    return "--" + match[1].trim();
  }
  return null;
}

// Parse XML and extract relevant data
function parseXML(xmlContent) {
  return new Promise((resolve, reject) => {
    xml2js.parseString(xmlContent, (err, result) => {
      if (err) {
        reject(err);
      } else {
        const event = result.EventNotificationAlert;
        const anpr = event.ANPR[0];
        const vehicleInfo = anpr.vehicleInfo[0];
        const vehicleType = vehicleInfo.vehicleType[0];
        const vehicleColor = vehicleInfo.color[0];
        const vehicleSpeed = vehicleInfo.speed[0];
        const licensePlate = anpr.licensePlate[0];

        resolve({
          ipAddress: event.ipAddress[0],
          dateTime: event.dateTime[0],
          eventType: event.eventType[0],
          licensePlate,
          vehicleType,
          vehicleColor,
          vehicleSpeed,
        });
      }
    });
  });
}

// Handle client connection
async function handleClient(socket) {
  console.log(`HTTP LISTENER: ${socket.remoteAddress} sending data.`);

  let requestData = Buffer.alloc(0);

  socket.on("data", (chunk) => {
    requestData = Buffer.concat([requestData, chunk]);
  });

  socket.on("end", async () => {
    const boundaryString = getBoundary(requestData);
    if (!boundaryString) {
      console.log("Boundary string not found in the request.");
      socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
      return;
    }

    const formDataList = extractFormData(requestData, boundaryString);

    for (const formData of formDataList) {
      if (formData.contentType.startsWith("image/")) {
        const folderPath = path.join(__dirname, "images", "lpr_images");
        fs.mkdirSync(folderPath, { recursive: true });
        const filePath = path.join(folderPath, formData.filename);
        fs.writeFileSync(filePath, formData.content);
        console.log(`IMAGE: Saved ${formData.filename}`);
      } else if (formData.contentType.startsWith("application/xml")) {
        const xmlContent = formData.content.toString("utf-8");
        const folderPath = path.join(__dirname, "xml", "lpr_logs");
        fs.mkdirSync(folderPath, { recursive: true });
        const filePath = path.join(folderPath, `${Date.now()}.xml`);
        fs.writeFileSync(filePath, xmlContent);
        console.log(`XML: Saved ${filePath}`);

        // Parse XML and save to MongoDB
        try {
          const data = await parseXML(xmlContent);

          const client = new MongoClient(mongoURL);
          await client.connect();
          const db = client.db(dbName);
          const collection = db.collection(collectionName);

          await collection.insertOne(data);
          console.log("XML: Data saved to MongoDB");

          await client.close();
        } catch (error) {
          console.error("Error parsing XML and saving to MongoDB:", error);
        }
      }
    }

    socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
    console.log("HTTP LISTENER: Data processed and response sent.");
  });

  socket.on("error", (err) => {
    console.error(
      `An error occurred while handling the client: ${err.message}`
    );
  });
}

// Start server
server.on("connection", handleClient);

server.listen(9091, localIP, () => {
  console.log(`HTTP LISTENER started listening on ${localIP}:9091.`);
});

server.on("error", (err) => {
  console.error(`Server error: ${err.message}`);
});
