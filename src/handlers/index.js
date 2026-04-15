const { createCustomerUpdatedHandler } = require("./customer-updated");

function createHandlers(dependencies) {
  return {
    "customer.updated": createCustomerUpdatedHandler(dependencies)
  };
}

module.exports = {
  createHandlers
};
