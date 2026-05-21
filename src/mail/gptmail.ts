import {fetch as undiciFetch, Agent, ProxyAgent, type Dispatcher, type RequestInit as UndiciRequestInit} from "undici";
import {appConfig} from "../config.js";
import {generateEmailName} from "./generate-email-name.js";
import {findLatestVerificationMail} from "./verification-matcher.js";

interface GPTMailEnvelope<T> {
    success?: boolean;
    data?: T;
    error?: string;
}

interface GPTMailGeneratedEmailData {
    email?: string;
}

interface GPTMailEmailItem {
    id?: string;
    email_address?: string;
    from_address?: string;
    subject?: string;
    content?: string;
    html_content?: string;
    has_html?: boolean;
    timestamp?: number;
    created_at?: string;
}

interface GPTMailEmailsData {
    emails?: GPTMailEmailItem[];
    count?: number;
}

const GPTMAIL_API_BASE_URL = "https://mail.chatgpt.org.uk";
const GPTMAIL_POLL_ATTEMPTS = 2;
const GPTMAIL_POLL_INTERVAL_MS = 10000;

function normalizeEmail(value: string): string {
    return String(value ?? "").trim().toLowerCase();
}

function ensureApiBaseUrlConfigured(): string {
    return GPTMAIL_API_BASE_URL;
}

function ensureApiKeyConfigured(): string {
    const apiKey = String(appConfig.gptMailApiKey ?? "").trim();
    if (!apiKey) {
        throw new Error("gptMailApiKey 未配置，请先在 config.json 中填写 GPTMail API Key");
    }
    return apiKey;
}

function pickRandomDomain(domains: string[]): string {
    const candidates = domains.map((item) => String(item ?? "").trim()).filter(Boolean);
    if (candidates.length === 0) {
        return String(appConfig.gptMailDomain ?? "").trim();
    }
    const index = Math.floor(Math.random() * candidates.length);
    return candidates[index] ?? "";
}

function buildDispatcher(): Dispatcher {
    const proxyUrl = String(appConfig.defaultProxyUrl ?? "").trim();
    return proxyUrl
        ? new ProxyAgent({
            uri: proxyUrl,
            requestTls: {rejectUnauthorized: false},
        })
        : new Agent({
            connect: {rejectUnauthorized: false},
        });
}

async function gptMailFetch(input: string | URL, init: UndiciRequestInit = {}) {
    return undiciFetch(input, {
        ...init,
        dispatcher: buildDispatcher(),
    } satisfies UndiciRequestInit);
}

function buildHeaders(extraHeaders: Record<string, string> = {}): Record<string, string> {
    return {
        Accept: "application/json",
        "X-API-Key": ensureApiKeyConfigured(),
        ...extraHeaders,
    };
}

async function requestJSON<T>(path: string, init: UndiciRequestInit = {}): Promise<T> {
    const baseUrl = ensureApiBaseUrlConfigured();
    const url = `${baseUrl}${path}`;
    const response = await gptMailFetch(url, init);
    const rawBody = await response.text();
    if (!response.ok) {
        throw new Error(`GPTMail 请求失败: ${response.status} body=${rawBody}`);
    }

    const payload = JSON.parse(rawBody) as GPTMailEnvelope<T>;
    if (!payload?.success) {
        throw new Error(`GPTMail 返回失败: ${payload?.error ?? rawBody}`);
    }
    return payload.data as T;
}

async function generateMailbox(): Promise<string> {
    const domain = pickRandomDomain(appConfig.gptMailDomains);
    const body: Record<string, string> = {
        prefix: generateEmailName(),
    };
    if (domain) {
        body.domain = domain;
    }

    const data = await requestJSON<GPTMailGeneratedEmailData>("/api/generate-email", {
        method: "POST",
        headers: buildHeaders({
            "Content-Type": "application/json",
        }),
        body: JSON.stringify(body),
    });
    const email = normalizeEmail(String(data?.email ?? ""));
    if (!email) {
        throw new Error(`GPTMail 生成邮箱返回异常: ${JSON.stringify(data)}`);
    }
    return email;
}

async function listEmails(email: string): Promise<GPTMailEmailItem[]> {
    const mailbox = normalizeEmail(email);
    if (!mailbox.includes("@")) {
        throw new Error(`邮箱格式不正确: ${email}`);
    }
    const url = new URL(`${ensureApiBaseUrlConfigured()}/api/emails`);
    url.searchParams.set("email", mailbox);
    const response = await gptMailFetch(url, {
        method: "GET",
        headers: buildHeaders(),
    });
    const rawBody = await response.text();
    console.log(`pollGPTMailOtp: listEmails rawBody=${rawBody}`);
    if (!response.ok) {
        throw new Error(`GPTMail 邮件列表请求失败: ${response.status} body=${rawBody}`);
    }
    const payload = JSON.parse(rawBody) as GPTMailEnvelope<GPTMailEmailsData>;
    if (!payload?.success) {
        throw new Error(`GPTMail 邮件列表返回失败: ${payload?.error ?? rawBody}`);
    }
    return Array.isArray(payload?.data?.emails) ? payload.data.emails : [];
}

async function getEmailDetail(id: string): Promise<GPTMailEmailItem> {
    const url = new URL(`${ensureApiBaseUrlConfigured()}/api/email/${encodeURIComponent(id)}`);
    const response = await gptMailFetch(url, {
        method: "GET",
        headers: buildHeaders(),
    });
    const rawBody = await response.text();
    console.log(`pollGPTMailOtp: getEmailDetail id=${id} rawBody=${rawBody}`);
    if (!response.ok) {
        throw new Error(`GPTMail 邮件详情请求失败: ${response.status} body=${rawBody}`);
    }
    const payload = JSON.parse(rawBody) as GPTMailEnvelope<GPTMailEmailItem>;
    if (!payload?.success) {
        throw new Error(`GPTMail 邮件详情返回失败: ${payload?.error ?? rawBody}`);
    }
    return payload.data ?? {} as GPTMailEmailItem;
}

async function deleteEmail(id: string): Promise<void> {
    await requestJSON(`/api/email/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: buildHeaders(),
    });
}

export function createGPTMailProvider() {
    return {
        async getEmailAddress() {
            ensureApiBaseUrlConfigured();
            ensureApiKeyConfigured();
            return generateMailbox();
        },
        async getEmailVerificationCode(email: string) {
            ensureApiBaseUrlConfigured();
            ensureApiKeyConfigured();

            for (let attempt = 1; attempt <= GPTMAIL_POLL_ATTEMPTS; attempt += 1) {
                console.log(
                    `pollGPTMailOtp: attempt=${attempt}/${GPTMAIL_POLL_ATTEMPTS} targetEmail=${email}`,
                );

                const list = await listEmails(email);
                const details = await Promise.all(
                    list.map(async (mail) => {
                        const id = String(mail?.id ?? "").trim();
                        const detail = id ? await getEmailDetail(id) : mail;
                        return {
                            ...detail,
                            id: String(detail?.id ?? mail?.id ?? ""),
                            sender: String(detail?.from_address ?? mail?.from_address ?? ""),
                            recipient: String(detail?.email_address ?? mail?.email_address ?? ""),
                            subject: String(detail?.subject ?? mail?.subject ?? ""),
                            content: String(detail?.content ?? mail?.content ?? ""),
                            timestamp: Number(detail?.timestamp ?? mail?.timestamp ?? 0),
                            extraTexts: [
                                String(detail?.html_content ?? mail?.html_content ?? ""),
                            ],
                        };
                    }),
                );
                const matchedMail = findLatestVerificationMail(details, {
                    targetEmail: normalizeEmail(email),
                });
                if (matchedMail?.verificationCode) {
                    await deleteEmail(matchedMail.id);
                    console.log(`gptMailOtpCode: ${matchedMail.verificationCode}`);
                    return matchedMail.verificationCode;
                }

                if (attempt < GPTMAIL_POLL_ATTEMPTS) {
                    await new Promise((resolve) => setTimeout(resolve, GPTMAIL_POLL_INTERVAL_MS));
                }
            }

            throw new Error(`GPTMail 中未找到验证码: targetEmail=${email}`);
        },
    };
}
