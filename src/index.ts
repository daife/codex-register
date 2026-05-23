import {readFile} from "node:fs/promises";
import {appConfig} from "./config.js";
import {generateRandomDeviceProfile} from "./device-profile.js";
import {OpenAIClient} from "./openai.js";
import {createSMSBroker} from "./sms/index.js";

function readArgValue(flag: string): string {
    const index = process.argv.indexOf(flag);
    if (index === -1) {
        return "";
    }
    return process.argv[index + 1] ?? "";
}

function hasFlag(flag: string): boolean {
    return process.argv.includes(flag);
}

function readNumberArg(flag: string): number | null {
    const raw = readArgValue(flag).trim();
    if (!raw) {
        return null;
    }
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : null;
}


const smsBroker = appConfig.heroSMSApiKey ? createSMSBroker({
    apiKey: appConfig.heroSMSApiKey,
    pollAttempts: appConfig.heroSMSPollAttempts,
    pollIntervalMs: appConfig.heroSMSPollIntervalMs,
    maxPrice: appConfig.heroSMSMaxPrice,
    country: appConfig.heroSMSCountry
}) : undefined

async function runOnce(emailOverride?: string): Promise<void> {
    const email = emailOverride || readArgValue("--email").trim();
    const manualOtp = hasFlag("--otp");
    const directSignupAuth = hasFlag("--sign");
    const saveAccessToken = hasFlag("--at");
    const deviceProfile = generateRandomDeviceProfile();
    if (directSignupAuth) {
        const client = new OpenAIClient({
            email: email || undefined,
            password: appConfig.defaultPassword,
            deviceProfile,
            manualMode: manualOtp,
            signupScreenHint: "signup",
            smsBroker
        });
        const result = await client.authRegisterAndAuthorizeHTTP();
        console.log(
            `[✅️授权成功] 邮箱：${client.email} 密码：${appConfig.defaultPassword} 授权文件：${result.authFile ?? ""}`,
        );
        return;
    }

    const registerClient = new OpenAIClient({
        email: email || undefined,
        password: appConfig.defaultPassword,
        deviceProfile,
        manualMode: manualOtp,
        smsBroker
    });
    await registerClient.authRegisterHTTP();

    const sessionFile = await registerClient.saveChatOpenAISessionSnapshot();
    console.log(`[chat_session_file] ${sessionFile}`);

    if (saveAccessToken) {
        const accessToken = await registerClient.getChatGPTAccessToken();
        const accessTokenFile = await registerClient.saveChatGPTAccessToken(accessToken);
        console.log(`[✅️注册成功] 邮箱：${registerClient.email} 密码：${appConfig.defaultPassword}`);
        console.log(`[access_token_file] ${accessTokenFile}`);
        console.log(`[access_token] ${accessToken}`);
        return;
    }

    const loginClient = new OpenAIClient({
        email: registerClient.email,
        password: appConfig.defaultPassword,
        deviceProfile,
        manualMode: manualOtp,
        smsBroker
    });
    const result = await loginClient.authLoginHTTP();
    console.log(
        `[✅️授权成功] 邮箱：${loginClient.email} 密码：${appConfig.defaultPassword} 授权文件：${result.authFile ?? ""}`,
    );
}

async function resolveEmails(input: string): Promise<string[]> {
    if (!input) return [];
    // 检查是否是文件路径 (简单判断：包含 . 或者 /)
    if (input.includes(".") || input.includes("/") || input.includes("\\")) {
        try {
            const content = await readFile(input, "utf8");
            return content.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        } catch (e) {
            // 如果读取失败，当做普通字符串处理
        }
    }
    // 逗号分隔
    if (input.includes(",")) {
        return input.split(",").map(s => s.trim()).filter(Boolean);
    }
    return [input];
}

async function main() {
    let round = 0;
    let successCount = 0;
    let failCount = 0;
    const manualEmailInput = readArgValue("--email").trim();
    const authOnly = hasFlag("--auth");
    const manualOtp = hasFlag("--otp");
    const maxRounds = readNumberArg("--n");

    const emails = await resolveEmails(manualEmailInput);

    if (authOnly) {
        if (emails.length === 0) {
            throw new Error("使用 --auth 时必须通过 --email 指定邮箱或邮箱列表文件");
        }
        for (const email of emails) {
            console.log(`[登录授权] 目标邮箱: ${email}`);
            try {
                const deviceProfile = generateRandomDeviceProfile();
                const client = new OpenAIClient({
                    email: email,
                    password: appConfig.defaultPassword,
                    deviceProfile,
                    manualMode: manualOtp,
                    smsBroker,
                });
                const result = await client.authLoginHTTP();
                console.log(
                    `[✅️授权成功] 邮箱：${client.email} 密码：${appConfig.defaultPassword} 授权文件：${result.authFile ?? ""}`,
                );
                // 授权模式下也保存登录态
                const sessionFile = await client.saveChatOpenAISessionSnapshot();
                console.log(`[chat_session_file] ${sessionFile}`);
                successCount++;
            } catch (error) {
                failCount++;
                console.error(`[❌️授权失败] ${email}`, error);
            }
        }
        return;
    }

    if (emails.length > 0) {
        for (const email of emails) {
            try {
                await runOnce(email);
                successCount++;
            } catch (error) {
                failCount++;
                console.error(`[❌️授权失败] ${email}`, error);
            }
        }
        return;
    }

    while (!maxRounds || round < maxRounds) {
        round += 1;
        console.log(
            `第 ${round} 轮开始: 成功=${successCount} 失败=${failCount} 模式=自动`,
        );
        try {
            await runOnce();
            successCount += 1;
        } catch (error) {
            failCount += 1;
            console.error(`[❌️授权失败]`, error);
        }

        if (appConfig.loopDelayMs > 0) {
            console.log(`[延迟] 轮次间等待 ${appConfig.loopDelayMs}ms`);
            await new Promise((resolve) => setTimeout(resolve, appConfig.loopDelayMs));
        }
    }

    console.log(
        `程序执行结束: 总计=${successCount + failCount} 成功=${successCount} 失败=${failCount}`,
    );
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
