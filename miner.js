import axios from 'axios';
import chalk from 'chalk';
import * as fs from 'fs/promises';
import { readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { S3 } from '@aws-sdk/client-s3';

// Class untuk mengelola penyimpanan di Storj menggunakan AWS SDK
class StorjClient {
    constructor() {
        this.client = new S3({
            endpoint: 'https://gateway.storjshare.io', // Ganti dengan endpoint Storj Anda
            region: 'ap1', // Region default
            credentials: {
                accessKeyId: 'jxv4sg337olsozycuumlk6ifaqxq', // Ganti dengan access key Anda
                secretAccessKey: 'jzgfqr3qspstyrlrcuyj6n5kpdr376dnuao376jmlvksk5w724rak', // Ganti dengan secret key Anda
            },
            forcePathStyle: true, // Wajib untuk Storj
        });
        this.bucket = 'kleido'; // Ganti dengan nama bucket Anda
    }

    // Upload file ke Storj
    async uploadFile(filePath, remoteFileName) {
        try {
            const fileContent = await fs.readFile(filePath);
            await this.client.putObject({
                Bucket: this.bucket,
                Key: remoteFileName,
                Body: fileContent,
            });
            console.log(chalk.green(`File ${filePath} berhasil diupload ke Storj sebagai ${remoteFileName}`));
        } catch (error) {
            console.error(chalk.red(`Gagal upload file ke Storj:`, error.message));
        }
    }

    // Download file dari Storj
    async downloadFile(remoteFileName, localFilePath) {
        try {
            const data = await this.client.getObject({
                Bucket: this.bucket,
                Key: remoteFileName,
            });
            await fs.writeFile(localFilePath, data.Body);
            console.log(chalk.green(`File ${remoteFileName} berhasil didownload dari Storj ke ${localFilePath}`));
        } catch (error) {
            console.error(chalk.red(`Gagal download file dari Storj:`, error.message));
        }
    }
}

// Class untuk bot penambangan
class KaleidoMiningBot {
    constructor(wallet, botIndex) {
        this.wallet = wallet;
        this.botIndex = botIndex;
        this.currentEarnings = { total: 0, pending: 0, paid: 0 };
        this.miningState = {
            isActive: false,
            worker: "quantum-rig-1",
            pool: "quantum-1",
            startTime: null
        };
        this.referralBonus = 0;
        this.stats = {
            hashrate: 75.5,
            shares: { accepted: 0, rejected: 0 },
            efficiency: 1.4,
            powerUsage: 120
        };
        this.sessionFile = join('sessions', `session_${wallet}.json`);
        this.storjClient = new StorjClient();
        
        this.api = axios.create({
            baseURL: 'https://kaleidofinance.xyz/api/testnet',
            headers: {
                'Content-Type': 'application/json',
                'Referer': 'https://kaleidofinance.xyz/testnet',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36'
            }
        });
    }

    // Muat sesi dari file atau Storj
    async loadSession() {
        try {
            // Coba download file sesi dari Storj
            await this.storjClient.downloadFile(`session_${this.wallet}.json`, this.sessionFile);

            const data = await fs.readFile(this.sessionFile, 'utf8');
            const session = JSON.parse(data);
            this.miningState.startTime = session.startTime;
            this.currentEarnings = session.earnings;
            this.referralBonus = session.referralBonus;
            console.log(chalk.green(`[Wallet ${this.botIndex}] Sesi sebelumnya berhasil dimuat`));
            return true;
        } catch (error) {
            return false;
        }
    }

    // Simpan sesi ke file dan upload ke Storj
    async saveSession() {
        const sessionData = {
            startTime: this.miningState.startTime,
            earnings: this.currentEarnings,
            referralBonus: this.referralBonus
        };
        
        try {
            await fs.writeFile(this.sessionFile, JSON.stringify(sessionData, null, 2));
            // Upload file sesi ke Storj
            await this.storjClient.uploadFile(this.sessionFile, `session_${this.wallet}.json`);
        } catch (error) {
            console.error(chalk.red(`[Wallet ${this.botIndex}] Gagal menyimpan sesi:`, error.message));
        }
    }

    // Inisialisasi bot
    async initialize() {
        try {
            // 1. Periksa status registrasi
            const regResponse = await this.retryRequest(
                () => this.api.get(`/check-registration?wallet=${this.wallet}`),
                "Pemeriksaan registrasi"
            );

            if (!regResponse.data.isRegistered) {
                throw new Error('Wallet tidak terdaftar');
            }

            // 2. Coba muat sesi sebelumnya
            const hasSession = await this.loadSession();
            
            if (!hasSession) {
                // Hanya inisialisasi nilai baru jika tidak ada sesi sebelumnya
                this.referralBonus = regResponse.data.userData.referralBonus;
                this.currentEarnings = {
                    total: regResponse.data.userData.referralBonus || 0,
                    pending: 0,
                    paid: 0
                };
                this.miningState.startTime = Date.now();
            }

            // 3. Mulai sesi penambangan
            this.miningState.isActive = true;
            
            console.log(chalk.green(`[Wallet ${this.botIndex}] Penambangan ${hasSession ? 'dilanjutkan' : 'diinisialisasi'} dengan sukses`));
            await this.startMiningLoop();

        } catch (error) {
            console.error(chalk.red(`[Wallet ${this.botIndex}] Gagal inisialisasi:`), error.message);
        }
    }

    // Retry request jika gagal
    async retryRequest(requestFn, operationName, retries = 3) {
        for (let i = 0; i < retries; i++) {
            try {
                return await requestFn();
            } catch (error) {
                if (i === retries - 1) throw error;
                console.log(chalk.yellow(`[${operationName}] Mencoba lagi (${i + 1}/${retries})...`));
                await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1)));
            }
        }
    }

    // Hitung pendapatan
    calculateEarnings() {
        const timeElapsed = (Date.now() - this.miningState.startTime) / 1000;
        return (this.stats.hashrate * timeElapsed * 0.0001) * (1 + this.referralBonus);
    }

    // Perbarui saldo
    async updateBalance(finalUpdate = false) {
        try {
            const newEarnings = this.calculateEarnings();
            const payload = {
                wallet: this.wallet,
                earnings: {
                    total: this.currentEarnings.total + newEarnings,
                    pending: finalUpdate ? 0 : newEarnings,
                    paid: finalUpdate ? this.currentEarnings.paid + newEarnings : this.currentEarnings.paid
                }
            };

            const response = await this.retryRequest(
                () => this.api.post('/update-balance', payload),
                "Pembaruan saldo"
            );

            if (response.data.success) {
                this.currentEarnings = {
                    total: response.data.balance,
                    pending: finalUpdate ? 0 : newEarnings,
                    paid: finalUpdate ? this.currentEarnings.paid + newEarnings : this.currentEarnings.paid
                };
                
                await this.saveSession();
                this.logStatus(finalUpdate);
            }
        } catch (error) {
            console.error(chalk.red(`[Wallet ${this.botIndex}] Gagal memperbarui:`), error.message);
        }
    }

    // Catat status penambangan
    logStatus(final = false) {
        const statusType = final ? "Status Akhir" : "Status Penambangan";
        const uptime = ((Date.now() - this.miningState.startTime) / 1000).toFixed(0);
        
        console.log(chalk.yellow(`
        === [Wallet ${this.botIndex}] ${statusType} ===
        Wallet: ${this.wallet}
        Waktu aktif: ${uptime}s | Aktif: ${this.miningState.isActive}
        Hashrate: ${this.stats.hashrate} MH/s
        Total: ${chalk.cyan(this.currentEarnings.total.toFixed(8))} KLDO
        Tertunda: ${chalk.yellow(this.currentEarnings.pending.toFixed(8))} KLDO
        Dibayar: ${chalk.green(this.currentEarnings.paid.toFixed(8))} KLDO
        Bonus Referral: ${chalk.magenta(`+${(this.referralBonus * 100).toFixed(1)}%`)}
        `));
    }

    // Mulai loop penambangan
    async startMiningLoop() {
        while (this.miningState.isActive) {
            await this.updateBalance();
            await new Promise(resolve => setTimeout(resolve, 30000)); // Perbarui setiap 30 detik
        }
    }

    // Hentikan penambangan
    async stop() {
        this.miningState.isActive = false;
        await this.updateBalance(true);
        await this.saveSession();
        return this.currentEarnings.paid;
    }
}

// Class untuk mengoordinasikan bot
export class MiningCoordinator {
    static instance = null;
    
    constructor() {
        if (MiningCoordinator.instance) {
            return MiningCoordinator.instance;
        }
        MiningCoordinator.instance = this;
        
        this.bots = [];
        this.totalPaid = 0;
        this.isRunning = false;
    }

    // Muat daftar wallet dari file
    async loadWallets() {
        try {
            const __dirname = dirname(fileURLToPath(import.meta.url));
            const data = await readFile(join(__dirname, 'wallets.txt'), 'utf8');
            return data.split('\n')
                .map(line => line.trim())
                .filter(line => line.startsWith('0x'));
        } catch (error) {
            console.error('Gagal memuat wallet:', error.message);
            return [];
        }
    }

    // Mulai koordinator
    async start() {
        if (this.isRunning) {
            console.log(chalk.yellow('Koordinator penambangan sudah berjalan'));
            return;
        }
        
        this.isRunning = true;
        const wallets = await this.loadWallets();
        
        if (wallets.length === 0) {
            console.log(chalk.red('Tidak ada wallet yang valid di wallets.txt'));
            return;
        }

        console.log(chalk.blue(`Memuat ${wallets.length} wallet\n`));

        // Inisialisasi semua bot
        this.bots = wallets.map((wallet, index) => {
            const bot = new KaleidoMiningBot(wallet, index + 1);
            bot.initialize();
            return bot;
        });

        // Handle shutdown
        process.on('SIGINT', async () => {
            console.log(chalk.yellow('\nMenghentikan penambang...'));
            this.totalPaid = (await Promise.all(this.bots.map(bot => bot.stop())))
                .reduce((sum, paid) => sum + paid, 0);
            
            console.log(chalk.green(`
            === Ringkasan Akhir ===
            Total Wallet: ${this.bots.length}
            Total Dibayar: ${this.totalPaid.toFixed(8)} KLDO
            `));
            process.exit();
        });
    }
}

// Jalankan koordinator
const coordinator = new MiningCoordinator();
await fs.mkdir('sessions', { recursive: true });
coordinator.start();