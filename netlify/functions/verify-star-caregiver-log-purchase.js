const crypto = require("crypto");

const STRIPE_API_BASE = "https://api.stripe.com/v1";
const EXPECTED_AMOUNT_CENTS = 1599;
const EXPECTED_CURRENCY = "usd";
const TOKEN_TTL_SECONDS = 15 * 60;

function json(statusCode, body) {
    return {
        statusCode,
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store"
        },
        body: JSON.stringify(body)
    };
}

function missingConfig(name) {
    return json(500, {
        verified: false,
        message: "Download verification is not fully configured.",
        missingConfiguration: name
    });
}

function createDownloadToken(sessionId, priceId, secret) {
    const payload = {
        sessionId,
        priceId,
        exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS
    };
    const payloadText = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = crypto
        .createHmac("sha256", secret)
        .update(payloadText)
        .digest("base64url");

    return `${payloadText}.${signature}`;
}

async function stripeRequest(path, secretKey) {
    const response = await fetch(`${STRIPE_API_BASE}${path}`, {
        headers: {
            Authorization: `Bearer ${secretKey}`
        }
    });

    if (!response.ok) {
        return null;
    }

    return response.json();
}

exports.handler = async (event) => {
    if (event.httpMethod !== "POST") {
        return json(405, { verified: false, message: "Method not allowed." });
    }

    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
    const expectedPriceId = process.env.STAR_CAREGIVER_LOG_STRIPE_PRICE_ID;
    const expectedProductId = process.env.STAR_CAREGIVER_LOG_STRIPE_PRODUCT_ID;
    const downloadTokenSecret = process.env.STAR_CAREGIVER_LOG_DOWNLOAD_TOKEN_SECRET;

    if (!stripeSecretKey) return missingConfig("STRIPE_SECRET_KEY");
    if (!expectedPriceId) return missingConfig("STAR_CAREGIVER_LOG_STRIPE_PRICE_ID");
    if (!downloadTokenSecret) return missingConfig("STAR_CAREGIVER_LOG_DOWNLOAD_TOKEN_SECRET");

    let body;
    try {
        body = JSON.parse(event.body || "{}");
    } catch (error) {
        return json(400, { verified: false, message: "We couldn't verify a completed purchase for this download." });
    }

    const sessionId = typeof body.session_id === "string" ? body.session_id.trim() : "";

    if (!sessionId || !sessionId.startsWith("cs_")) {
        return json(400, { verified: false, message: "We couldn't verify a completed purchase for this download." });
    }

    try {
        const session = await stripeRequest(`/checkout/sessions/${encodeURIComponent(sessionId)}`, stripeSecretKey);

        if (!session || session.object !== "checkout.session") {
            return json(403, { verified: false, message: "We couldn't verify a completed purchase for this download." });
        }

        const lineItems = await stripeRequest(
            `/checkout/sessions/${encodeURIComponent(sessionId)}/line_items?limit=100&expand[]=data.price.product`,
            stripeSecretKey
        );

        const matchedLineItem = lineItems?.data?.find((item) => {
            const price = item.price;
            const productId = typeof price?.product === "string" ? price.product : price?.product?.id;
            const matchesPrice = price?.id === expectedPriceId;
            const matchesProduct = !expectedProductId || productId === expectedProductId;
            const matchesAmount = price?.unit_amount === EXPECTED_AMOUNT_CENTS;
            const matchesCurrency = price?.currency === EXPECTED_CURRENCY;

            return matchesPrice && matchesProduct && matchesAmount && matchesCurrency;
        });

        const paid = session.payment_status === "paid";
        const oneTimePayment = session.mode === "payment";
        const sessionAmount = session.amount_total === EXPECTED_AMOUNT_CENTS;
        const sessionCurrency = session.currency === EXPECTED_CURRENCY;

        if (!paid || !oneTimePayment || !sessionAmount || !sessionCurrency || !matchedLineItem) {
            return json(403, { verified: false, message: "We couldn't verify a completed purchase for this download." });
        }

        const token = createDownloadToken(session.id, expectedPriceId, downloadTokenSecret);

        return json(200, {
            verified: true,
            downloadUrl: `/.netlify/functions/download-star-caregiver-log?token=${encodeURIComponent(token)}`
        });
    } catch (error) {
        return json(500, { verified: false, message: "We couldn't verify a completed purchase for this download." });
    }
};
