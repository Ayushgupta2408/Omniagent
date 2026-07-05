 
export function validateEnv(): void {
  const provider = (process.env.AI_PROVIDER ?? 'groq').toLowerCase();

  const required: Record<string, string[]> = {
    groq:      ['GROQ_API_KEY'],
    anthropic: ['ANTHROPIC_API_KEY'],
    openai:    ['OPENAI_API_KEY'],
  };

  const missing = (required[provider] ?? []).filter(
    (k) => !process.env[k] || (process.env[k] ?? '').includes('your_')
  );

  if (missing.length > 0) {
    console.error('\n Missing required environment variables:');
    missing.forEach((k) => console.error(`   ${k}`));
    console.error('\nSteps to fix:');
    console.error('  1. Copy server/.env.example to server/.env');
    console.error(`  2. Fill in your ${provider.toUpperCase()} API key`);
    console.error('  3. Restart the server\n');
    process.exit(1);
  }

  console.log(`✓ Env valid — provider: ${provider}`);
}
