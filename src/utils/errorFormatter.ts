export function formatError(error: any) {
  if (error.response) {
    return {
      status: error.response.status,
      message: error.response.data?.message || "Courier API Error",
      details: error.response.data?.errors || null,
    };
  }
  return { status: 500, message: error.message || "Unknown Error" };
}
