import { config } from 'dotenv';
import { createBlobService, createQueueService, createTableService, TableUtilities } from 'azure-storage';
import Jimp from 'jimp';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables from .env file
config();

const blobService = createBlobService(process.env.AZURE_STORAGE_ACCOUNT, process.env.STORAGE_KEY);
const queueService = createQueueService(process.env.AZURE_STORAGE_ACCOUNT, process.env.STORAGE_KEY);
const tableService = createTableService(process.env.AZURE_STORAGE_ACCOUNT, process.env.STORAGE_KEY);

// Get the directory name of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function processQueue() {
    queueService.getMessages('resize-queue', { numofmessages: 1, visibilitytimeout: 30 }, (error, result, response) => {
        if (!error && result.length > 0) {
            const message = result[0];
            const { blobName } = JSON.parse(message.messageText);
            console.log(`Processing message for blob: ${blobName}`);

            // Download the image
            const downloadPath = path.join(__dirname, 'downloads', blobName);
            blobService.getBlobToLocalFile('images', blobName, downloadPath, (error, result, response) => {
                if (!error) {
                    console.log(`Downloaded image to: ${downloadPath}`);

                    // Resize the image
                    Jimp.read(downloadPath)
                        .then(image => {
                            return image.resize(128, Jimp.AUTO).writeAsync(downloadPath);
                        })
                        .then(() => {
                            console.log(`Resized image saved to: ${downloadPath}`);

                            // Upload the thumbnail
                            const thumbnailName = `thumb-${blobName}`;
                            blobService.createBlockBlobFromLocalFile('thumbnails', thumbnailName, downloadPath, (error, result, response) => {
                                if (!error) {
                                    console.log(`Uploaded thumbnail as: ${thumbnailName}`);

                                    // Update the table with the thumbnail URL
                                    const thumbnailUrl = blobService.getUrl('thumbnails', thumbnailName);
                                    const entGen = TableUtilities.entityGenerator;
                                    const updateEntity = {
                                        PartitionKey: entGen.String('review'),
                                        RowKey: entGen.String(blobName),
                                        ThumbnailUrl: entGen.String(thumbnailUrl)
                                    };
                                    tableService.mergeEntity('reviews', updateEntity, (error, result, response) => {
                                        if (!error) {
                                            console.log(`Updated table storage with thumbnail URL: ${thumbnailUrl}`);

                                            // Delete the original message from the queue
                                            queueService.deleteMessage('resize-queue', message.messageId, message.popReceipt, (error, response) => {
                                                if (!error) {
                                                    console.log(`Deleted message from queue for blob: ${blobName}`);
                                                } else {
                                                    console.error(`Failed to delete message from queue: ${error}`);
                                                }
                                            });
                                        } else {
                                            console.error(`Failed to update table storage: ${error}`);
                                        }
                                    });
                                } else {
                                    console.error(`Failed to upload thumbnail: ${error}`);
                                }
                            });
                        })
                        .catch(err => {
                            console.error(`Failed to resize image: ${err}`);
                        });
                } else {
                    console.error(`Failed to download image: ${error}`);
                }
            });
        } else if (error) {
            console.error(`Failed to get messages from queue: ${error}`);
        }
    });
}

// Continuously process the queue
setInterval(processQueue, 10000);
