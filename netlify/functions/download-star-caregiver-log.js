const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PRIVATE_PDF_PATH = "private-downloads/STAR-Daily-Caregiver-Log.pdf";

function response(statusCode, body, headers = {}) {
    return {
        statusCode,
        headers: {
            "Cache-Control": "no-store",
            ...headers
        },
        body,
        isBase64Encoded: headers["Content-Type"] === "application/pdf"
    };
}

function json(statusCode, body) {
    return response(statusCode, JSON.stringify(body), {
        "Content-Type": "application/json"
    });
}

function safeCustomerMessage() {
    return {
        message: "We couldn't verify a completed purchase for this download."
    };
}

function verifyToken(token, secret) {
    const [payloadText, signature] = String(token || "").split(".");

    if (!payloadText || !signature) {
        return null;
    }

    const expectedSignature = crypto
        .createHmac("sha256", secret)
        .update(payloadText)
        .digest("base64url");

    const validSignature = crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature)
    );

    if (!validSignature) {
        return null;
    }

    const payload = JSON.parse(Buffer.from(payloadText, "base64url").toString("utf8"));

    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
        return null;
    }

    return payload;
}

exports.handler = async (event) => {
    if (event.httpMethod !== "GET") {
        return json(405, { message: "Method not allowed." });
    }

    const downloadTokenSecret = process.env.STAR_CAREGIVER_LOG_DOWNLOAD_TOKEN_SECRET;
    const expectedPriceId = process.env.STAR_CAREGIVER_LOG_STRIPE_PRICE_ID;

    if (!downloadTokenSecret || !expectedPriceId) {
        return json(500, {
            message: "Secure PDF delivery is not fully configured."
        });
    }

    let payload;
    try {
        payload = verifyToken(event.queryStringParameters?.token, downloadTokenSecret);
    } catch (error) {
        return json(403, safeCustomerMessage());
    }

    if (!payload || payload.priceId !== expectedPriceId || !payload.sessionId?.startsWith("cs_")) {
        return json(403, safeCustomerMessage());
    }

    try {
        const possiblePdfPaths = [
            path.resolve(process.cwd(), PRIVATE_PDF_PATH),
            path.resolve(__dirname, PRIVATE_PDF_PATH),
            path.resolve(__dirname, "..", "..", PRIVATE_PDF_PATH)
        ];
        const pdfPath = possiblePdfPaths.find((candidate) => fs.existsSync(candidate));

        if (!pdfPath) {
            return json(500, {
                message: "The download is temporarily unavailable. Please contact North Star Solutions Tech."
            });
        }

        const pdfBuffer = fs.readFileSync(pdfPath);

        return response(200, pdfBuffer.toString("base64"), {
            "Content-Type": "application/pdf",
            "Content-Disposition": 'attachment; filename="STAR-Daily-Caregiver-Log.pdf"',
            "Content-Length": String(pdfBuffer.length)
        });
    } catch (error) {
        return json(500, {
            message: "The download is temporarily unavailable. Please contact North Star Solutions Tech."
        });
    }
};
