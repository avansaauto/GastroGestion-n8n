export class RecipeQueryError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'RecipeQueryError'
  }
}
