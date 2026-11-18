// Count only responses handled by the static-file middleware. A fall-through
// request belongs to a later API/page route, even when that route returns 200.
function countStaticResponses(middleware, onHit) {
  return (req, res, next) => {
    const finished = () => {
      if (res.statusCode >= 200 && res.statusCode < 300) onHit();
    };
    res.once('finish', finished);
    middleware(req, res, error => {
      res.removeListener('finish', finished);
      next(error);
    });
  };
}

module.exports = { countStaticResponses };
