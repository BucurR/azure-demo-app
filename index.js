import express from "express";
import bodyParser from "body-parser";
import multer from "multer";
import {
  createBlobService,
  createQueueService,
  createTableService,
  TableQuery,
  TableUtilities,
} from "azure-storage";
import path from "path";
import { config } from "dotenv";

// Load environment variables from .env file
config();

const app = express();
const blobService = createBlobService(
  process.env.AZURE_STORAGE_ACCOUNT,
  process.env.STORAGE_KEY
);
const queueService = createQueueService(
  process.env.AZURE_STORAGE_ACCOUNT,
  process.env.STORAGE_KEY
);
const tableService = createTableService(
  process.env.AZURE_STORAGE_ACCOUNT,
  process.env.STORAGE_KEY
);

const upload = multer({ dest: "uploads/" });

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public")); // Serve static files from 'public' directory

app.set("view engine", "ejs");

app.get("/", (req, res) => {
  const query = new TableQuery().top(100);
  tableService.queryEntities(
    "reviews",
    query,
    null,
    (error, result, response) => {
      if (!error) {
        const reviews = result.entries.sort(
          (a, b) => new Date(b.Timestamp._) - new Date(a.Timestamp._)
        );
        res.render("index", { reviews });
      } else {
        res.status(500).send(error);
      }
    }
  );
});

app.post("/post", upload.single("image"), (req, res) => {
  const reviewText = req.body.review;
  const username = req.body.username || "Anonymous";
  const imagePath = req.file ? req.file.path : null;

  // Generate a unique identifier for the review
  const blobName = `${Date.now()}-${
    req.file ? req.file.originalname : "noimage"
  }`;

  if (imagePath) {
    // Upload the image to Blob Storage
    blobService.createBlockBlobFromLocalFile(
      "images",
      blobName,
      imagePath,
      (error, result, response) => {
        if (!error) {
          // Add the image to the queue for processing
          queueService.createMessage(
            "resize-queue",
            JSON.stringify({ blobName }),
            (error, result, response) => {
              if (!error) {
                // Save the review to Table Storage
                saveReview(
                  username,
                  reviewText,
                  blobName,
                  blobService.getUrl("images", blobName),
                  "",
                  res
                );
                fs.unlink(imagePath, (err) => {
                  if (err) {
                    console.error(`Failed to delete uploaded image: ${err}`);
                  } else {
                    console.log(`Deleted uploaded image: ${imagePath}`);
                  }
                });
              } else {
                res.status(500).send(error);
              }
            }
          );
        } else {
          res.status(500).send(error);
        }
      }
    );
  } else {
    // Save the review without an image
    saveReview(username, reviewText, blobName, "", "", res);
  }
});

function saveReview(
  username,
  reviewText,
  blobName,
  imageUrl,
  thumbnailUrl,
  res
) {
  const entGen = TableUtilities.entityGenerator;
  const task = {
    PartitionKey: entGen.String("review"),
    RowKey: entGen.String(blobName),
    Username: entGen.String(username),
    Text: entGen.String(reviewText),
    ImageUrl: entGen.String(imageUrl),
    ThumbnailUrl: entGen.String(thumbnailUrl),
  };
  tableService.insertEntity("reviews", task, (error, result, response) => {
    if (!error) {
      res.redirect("/");
    } else {
      res.status(500).send(error);
    }
  });
}

app.listen(3000, () => {
  console.log("Guestbook app listening on port 3000!");
});
