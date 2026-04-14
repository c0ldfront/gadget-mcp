declare module "*.ndjson" {
	const text: string;
	export default text;
}

declare module "*.json" {
	const value: string;
	export default value;
}
